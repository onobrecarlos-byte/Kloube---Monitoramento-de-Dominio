import argparse
import json
import sys
from monitor_engine import DomainStore, check_single_domain

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Skill CLI para conferência de domínios e direcionamento Kloube"
    )
    parser.add_argument(
        "--domain",
         "-d",
        help="Link de um domínio específico para conferir (ex: kloube.com.br)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Conferir todos os domínios cadastrados no Kloube Domain Monitor",
    )
    parser.add_argument(
        "--notify",
        action="store_true",
        default=True,
        help="Enviar notificação no computador e e-mails onobrecarlos@gmail.com e alertas.kloube@gmail.com caso esteja fora do ar",
    )
    parser.add_argument(
        "--test-alert",
        action="store_true",
        help="Disparar um alerta de teste (Computador + E-mail SMTP)",
    )
    args = parser.parse_args()

    store = DomainStore()

    if args.test_alert:
        alert = store.trigger_alert(
            {"domain": "exemplo-teste.com.br", "name": "Teste de Alerta Kloube"},
            {"status": "offline", "reason": "Disparo de teste Kloube (Computador + E-mail SMTP)"},
            force=True,
        )
        print(f"Desktop enviado: {alert['desktop_sent']}")
        print(f"Email enviado: {alert['email_sent']} | Info: {alert['email_info']}")
        return

    if args.domain:
        res = check_single_domain(args.domain)
        icon = "🟢 ATIVO" if res["status"] == "online" else "🔴 FORA DO AR"
        print(f"{icon} | Domínio: {args.domain}")
        print(f"Motivo: {res['reason']}")
        print(f"URL Final: {res.get('final_url') or 'N/A'}")
        if res["status"] == "offline" and args.notify:
            store.trigger_alert({"domain": args.domain, "name": args.domain}, res, force=True)
            print("-> Notificação enviada para o computador e para onobrecarlos@gmail.com, alertas.kloube@gmail.com")
        sys.exit(0 if res["status"] == "online" else 1)

    # Check all stored domains
    data = store.load()
    domains = data.get("domains", [])
    if not domains:
        print("Nenhum domínio cadastrado ainda em data.json.")
        return

    for d in domains:
        if d.get("status") == "draft":
            print(f"⏸️ RASCUNHO | {d['domain']} ({d.get('name', '')}) -> Monitoramento pausado")
            continue
        prev_status = d.get("status", "unknown")
        res = check_single_domain(d["domain"], d.get("expected_redirect", ""))
        d.update(res)
        icon = "🟢 ATIVO" if res["status"] == "online" else "🔴 FORA DO AR"
        print(f"{icon} | {d['domain']} ({d.get('name', '')}) -> {res['reason']}")
        if res["status"] == "offline" and args.notify and prev_status != "offline":
            store.trigger_alert(d, res)
    store.save(data)


if __name__ == "__main__":
    main()
