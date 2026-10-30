import concurrent.futures
import json
import mimetypes
import os
import sys
import threading
import time
import urllib.parse
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from monitor_engine import (
    BRT_TZ,
    DEFAULT_EMAIL,
    DomainStore,
    check_single_domain,
    normalize_domain_input,
    now_iso,
)

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
PORT = int(os.environ.get("KLOUBE_PORT", "8765"))

store = DomainStore()


def verify_and_update_domain(domain_id: str, notify_on_fail: bool = True) -> dict | None:
    data = store.load()
    target = None
    for d in data.get("domains", []):
        if d["id"] == domain_id:
            target = d
            break

    if not target:
        return None

    prev_status = target.get("status", "unknown")
    result = check_single_domain(
        target["domain"], target.get("expected_redirect", "")
    )

    # Reload to avoid race conditions
    data = store.load()
    updated_domain = None
    for d in data.get("domains", []):
        if d["id"] == domain_id:
            d.update(result)
            updated_domain = dict(d)
            break
    store.save(data)

    # Trigger notification if domain is offline (Fora do Ar)
    if updated_domain and result["status"] == "offline" and notify_on_fail:
        # Notify if it just went offline, or was never checked before, or user manually requested check
        if prev_status != "offline" or prev_status == "unknown":
            store.trigger_alert(updated_domain, result)

    return updated_domain


def verify_all_domains(force_notify: bool = False, include_drafts: bool = False) -> list[dict]:
    data = store.load()
    all_domains = data.get("domains", [])
    domains = [
        d for d in all_domains
        if include_drafts or d.get("status") != "draft"
    ]
    if not domains:
        return all_domains

    prev_statuses = {d["id"]: d.get("status", "unknown") for d in domains}

    def _check(d_item):
        res = check_single_domain(
            d_item["domain"], d_item.get("expected_redirect", "")
        )
        return d_item["id"], res

    results_map = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(_check, d) for d in domains]
        for fut in concurrent.futures.as_completed(futures):
            try:
                d_id, res = fut.result()
                results_map[d_id] = res
            except Exception as e:
                pass

    data = store.load()
    to_alert = []
    for d in data.get("domains", []):
        res = results_map.get(d["id"])
        if res:
            old_st = prev_statuses.get(d["id"], "unknown")
            d.update(res)
            if res["status"] == "offline" and (
                old_st != "offline" or force_notify
            ):
                to_alert.append((dict(d), res))
    store.save(data)

    for d_copy, res in to_alert:
        store.trigger_alert(d_copy, res)

    return data.get("domains", [])


def _get_latest_checked_ts(domains: list[dict]) -> float:
    latest_ts = 0.0
    for d in domains:
        raw_dt = d.get("checked_at", "")
        if raw_dt:
            try:
                dt = datetime.strptime(raw_dt, "%Y-%m-%d %H:%M:%S").replace(
                    tzinfo=BRT_TZ
                )
                latest_ts = max(latest_ts, dt.timestamp())
            except Exception:
                pass
    return latest_ts


def _should_refresh_domains(data: dict) -> bool:
    domains = [
        d for d in data.get("domains", []) if d.get("status") != "draft"
    ]
    if not domains:
        return False
    if os.environ.get("VERCEL") and not store.tmp_path.exists():
        return True
    interval = int(
        data.get("settings", {}).get("check_interval_seconds", 3600)
    )
    interval = max(60, interval)
    latest_ts = _get_latest_checked_ts(domains)
    if latest_ts <= 0:
        return True
    return (time.time() - latest_ts) >= interval


def background_monitor_loop():
    """Continuously monitors all registered domains strictly at the configured interval."""
    time.sleep(5)
    while True:
        try:
            data = store.load()
            interval = int(
                data.get("settings", {}).get("check_interval_seconds", 3600)
            )
            interval = max(60, interval)
            domains = data.get("domains", [])
            if domains:
                latest_ts = _get_latest_checked_ts(domains)
                elapsed = time.time() - latest_ts if latest_ts > 0 else interval
                if elapsed >= interval:
                    verify_all_domains(force_notify=False)
                    time.sleep(interval)
                else:
                    wait_remaining = max(15, int(interval - elapsed))
                    time.sleep(wait_remaining)
            else:
                time.sleep(interval)
        except Exception:
            time.sleep(3600)


class KloubeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Clean console logs
        pass

    def _send_json(self, payload: dict, status: int = 200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        body = self.rfile.read(length).decode("utf-8", errors="ignore")
        return json.loads(body) if body else {}

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/state":
            data = store.load()
            accounts = list(data.get("users", {}).keys())
            safe_data = {k: v for k, v in data.items() if k != "users"}
            return self._send_json(
                {
                    "ok": True,
                    "accounts": accounts,
                    "server_time": now_iso(),
                    "needs_refresh": _should_refresh_domains(data),
                    **safe_data,
                }
            )

        if path == "/api/cron":
            verify_all_domains(force_notify=False, include_drafts=False)
            data = store.load()
            safe_data = {k: v for k, v in data.items() if k != "users"}
            return self._send_json({"ok": True, **safe_data})

        # Serve static files from PUBLIC_DIR
        if path == "/" or path == "":
            file_path = PUBLIC_DIR / "index.html"
        else:
            rel = path.lstrip("/")
            file_path = (PUBLIC_DIR / rel).resolve()
            if not str(file_path).startswith(str(PUBLIC_DIR.resolve())):
                self.send_error(403)
                return

        if not file_path.exists() or not file_path.is_file():
            self.send_error(404)
            return

        mime, _ = mimetypes.guess_type(str(file_path))
        mime = mime or "application/octet-stream"
        content = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            body = self._read_json()
        except Exception:
            return self._send_json(
                {"ok": False, "error": "JSON inválido"}, status=400
            )

        if path == "/api/domains":
            raw_domain = (body.get("domain") or "").strip()
            name = (body.get("name") or "").strip()
            expected_redirect = (body.get("expected_redirect") or "").strip()

            try:
                clean_host, clean_url = normalize_domain_input(raw_domain)
            except ValueError as e:
                return self._send_json({"ok": False, "error": str(e)}, status=400)

            data = store.load()
            for existing in data.get("domains", []):
                if existing["domain"].lower() == clean_host.lower():
                    return self._send_json(
                        {
                            "ok": False,
                            "error": f"O domínio '{clean_host}' já está cadastrado.",
                        },
                        status=400,
                    )

            new_id = f"dom_{uuid.uuid4().hex[:10]}"
            new_entry = {
                "id": new_id,
                "domain": clean_host,
                "url": clean_url,
                "name": name or clean_host,
                "expected_redirect": expected_redirect,
                "status": "checking",
                "status_label": "Verificando...",
                "reason": "Conferindo apontamento e direcionamento...",
                "http_code": None,
                "final_url": "",
                "ip_address": "",
                "response_time_ms": 0,
                "checked_at": now_iso(),
                "created_at": now_iso(),
            }
            data.setdefault("domains", []).insert(0, new_entry)
            store.save(data)

            # Check immediately and notify if offline
            updated = verify_and_update_domain(new_id, notify_on_fail=True)
            return self._send_json(
                {"ok": True, "domain": updated, "state": store.load()}
            )

        if path.startswith("/api/domains/") and path.endswith("/check"):
            parts = path.strip("/").split("/")
            if len(parts) == 4:
                domain_id = parts[2]
                data = store.load()
                target = next(
                    (d for d in data.get("domains", []) if d["id"] == domain_id),
                    None,
                )
                if not target:
                    return self._send_json(
                        {"ok": False, "error": "Domínio não encontrado"},
                        status=404,
                    )
                res = check_single_domain(
                    target["domain"], target.get("expected_redirect", "")
                )
                for d in data.get("domains", []):
                    if d["id"] == domain_id:
                        d.update(res)
                        target = dict(d)
                        break
                store.save(data)
                if res["status"] == "offline":
                    store.trigger_alert(target, res)
                return self._send_json(
                    {"ok": True, "domain": target, "state": store.load()}
                )

        if path.startswith("/api/domains/") and path.endswith("/draft"):
            parts = path.strip("/").split("/")
            if len(parts) == 4:
                domain_id = parts[2]
                data = store.load()
                target = next(
                    (d for d in data.get("domains", []) if d["id"] == domain_id),
                    None,
                )
                if not target:
                    return self._send_json(
                        {"ok": False, "error": "Domínio não encontrado"},
                        status=404,
                    )
                if target.get("status") == "draft":
                    res = check_single_domain(
                        target["domain"], target.get("expected_redirect", "")
                    )
                    target.update(res)
                    store.save(data)
                    if res["status"] == "offline":
                        store.trigger_alert(dict(target), res)
                else:
                    target["status"] = "draft"
                    target["status_label"] = "Rascunho"
                    target["reason"] = "Salvo em rascunho · Monitoramento pausado"
                    store.save(data)
                return self._send_json(
                    {"ok": True, "domain": dict(target), "state": store.load()}
                )

        if path == "/api/activate-drafts":
            verify_all_domains(force_notify=True, include_drafts=True)
            return self._send_json({"ok": True, **store.load()})

        if path == "/api/check-all":
            verify_all_domains(force_notify=True, include_drafts=False)
            return self._send_json({"ok": True, **store.load()})

        if path == "/api/settings":
            data = store.load()
            settings = data.setdefault("settings", {})
            settings["notify_email"] = (
                body.get("notify_email") or DEFAULT_EMAIL
            ).strip()
            settings["desktop_notifications"] = bool(
                body.get("desktop_notifications", True)
            )
            settings["email_notifications"] = bool(
                body.get("email_notifications", True)
            )
            settings["check_interval_seconds"] = max(
                30, int(body.get("check_interval_seconds") or 180)
            )
            settings["smtp_host"] = (
                body.get("smtp_host") or "smtp.gmail.com"
            ).strip()
            settings["smtp_port"] = int(body.get("smtp_port") or 587)
            settings["smtp_user"] = (
                body.get("smtp_user") or "growthnobre@gmail.com"
            ).strip()
            if "smtp_pass" in body and body["smtp_pass"].strip():
                settings["smtp_pass"] = body["smtp_pass"].strip().replace(" ", "")
            store.save(data)
            return self._send_json({"ok": True, **store.load()})

        if path == "/api/test-notification":
            dummy_domain = {
                "domain": "exemplo-teste.com.br",
                "name": "Teste de Alerta Kloube",
            }
            dummy_result = {
                "status": "offline",
                "reason": "Disparo de teste solicitado no painel Kloube (Computador + E-mail)",
                "checked_at": now_iso(),
            }
            alert = store.trigger_alert(dummy_domain, dummy_result, force=True)
            return self._send_json(
                {"ok": True, "alert": alert, "state": store.load()}
            )

        if path == "/api/auth/login":
            email = (body.get("email") or "").strip()
            password = (body.get("password") or "").strip()
            ok, msg_or_email = store.verify_login(email, password)
            if not ok:
                return self._send_json({"ok": False, "error": msg_or_email}, status=401)
            return self._send_json({"ok": True, "user": {"email": msg_or_email}})

        if path == "/api/auth/send-reset-code":
            email = (body.get("email") or "").strip()
            ok, msg = store.send_password_reset_code(email)
            if not ok:
                return self._send_json({"ok": False, "error": msg}, status=400)
            return self._send_json({"ok": True, "message": msg})

        if path == "/api/auth/reset-password":
            email = (body.get("email") or "").strip()
            new_password = (body.get("new_password") or "").strip()
            code = (body.get("code") or "").strip()
            logged_in_user = (body.get("logged_in_user") or "").strip()
            bypass = bool(logged_in_user and logged_in_user.lower() == email.lower())
            ok, msg_or_email = store.change_user_password(
                email, new_password, code=code, bypass_code=bypass
            )
            if not ok:
                return self._send_json({"ok": False, "error": msg_or_email}, status=400)
            return self._send_json(
                {
                    "ok": True,
                    "user": {"email": msg_or_email},
                    "message": f"Senha de {msg_or_email} alterada com sucesso!",
                }
            )

        if path == "/api/auth/create-user":
            requester_email = (body.get("requester_email") or "").strip()
            new_email = (body.get("new_email") or "").strip()
            new_password = (body.get("new_password") or "").strip()
            ok, msg_or_email = store.create_user_account(
                requester_email, new_email, new_password
            )
            if not ok:
                return self._send_json({"ok": False, "error": msg_or_email}, status=403)
            data = store.load()
            return self._send_json(
                {
                    "ok": True,
                    "created_email": msg_or_email,
                    "accounts": list(data.get("users", {}).keys()),
                }
            )

        if path == "/api/clear-alerts":
            data = store.load()
            data["alerts"] = []
            store.save(data)
            return self._send_json({"ok": True, **store.load()})

        return self._send_json(
            {"ok": False, "error": "Rota não encontrada"}, status=404
        )

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/domains/"):
            domain_id = path.split("/api/domains/")[1].strip("/")
            try:
                body = self._read_json()
            except Exception:
                return self._send_json(
                    {"ok": False, "error": "JSON inválido"}, status=400
                )

            raw_domain = (body.get("domain") or "").strip()
            name = (body.get("name") or "").strip()
            expected_redirect = (body.get("expected_redirect") or "").strip()

            try:
                clean_host, clean_url = normalize_domain_input(raw_domain)
            except ValueError as e:
                return self._send_json(
                    {"ok": False, "error": str(e)}, status=400
                )

            data = store.load()
            found = False
            for d in data.get("domains", []):
                if (
                    d["id"] != domain_id
                    and d["domain"].lower() == clean_host.lower()
                ):
                    return self._send_json(
                        {
                            "ok": False,
                            "error": f"O domínio '{clean_host}' já existe na lista.",
                        },
                        status=400,
                    )
                if d["id"] == domain_id:
                    d["domain"] = clean_host
                    d["url"] = clean_url
                    d["name"] = name or clean_host
                    d["expected_redirect"] = expected_redirect
                    found = True

            if not found:
                return self._send_json(
                    {"ok": False, "error": "Domínio não encontrado."}, status=404
                )

            store.save(data)
            updated = verify_and_update_domain(domain_id, notify_on_fail=True)
            return self._send_json(
                {"ok": True, "domain": updated, "state": store.load()}
            )

        return self._send_json(
            {"ok": False, "error": "Rota não encontrada"}, status=404
        )

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/domains/"):
            domain_id = path.split("/api/domains/")[1].strip("/")
            data = store.load()
            before = len(data.get("domains", []))
            data["domains"] = [
                d for d in data.get("domains", []) if d["id"] != domain_id
            ]
            if len(data["domains"]) == before:
                return self._send_json(
                    {"ok": False, "error": "Domínio não encontrado"}, status=404
                )
            store.save(data)
            return self._send_json({"ok": True, "state": store.load()})

        return self._send_json(
            {"ok": False, "error": "Rota não encontrada"}, status=404
        )


def _free_port_if_in_use(port: int):
    import subprocess
    my_pid = os.getpid()
    try:
        out = subprocess.check_output(
            ["netstat", "-ano", "-p", "TCP"],
            text=True,
            errors="ignore",
        )
        for line in out.splitlines():
            if f"127.0.0.1:{port}" in line and "LISTENING" in line:
                parts = line.split()
                pid = int(parts[-1])
                if pid != my_pid and pid > 0:
                    subprocess.run(
                        ["taskkill", "/F", "/PID", str(pid)],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
    except Exception:
        pass


def main():
    _free_port_if_in_use(PORT)
    monitor_thread = threading.Thread(
        target=background_monitor_loop, daemon=True
    )
    monitor_thread.start()

    server = ThreadingHTTPServer(("127.0.0.1", PORT), KloubeHandler)
    print(f"====================================================")
    print(f"  KLOUBE DOMAIN MONITOR ATIVO")
    print(f"  Painel: http://localhost:{PORT}")
    print(f"  Notificacoes: Computador + {DEFAULT_EMAIL}")
    print(f"====================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrando servidor...")
        server.server_close()


if __name__ == "__main__":
    main()
