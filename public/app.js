const state = {
    domains: [],
    settings: {
        notify_email: 'onobrecarlos@gmail.com, alertas.kloube@gmail.com',
        desktop_notifications: true,
        email_notifications: true,
        check_interval_seconds: 3600,
        smtp_user: 'growthnobre@gmail.com',
        smtp_pass: '',
    },
    alerts: [],
    filter: 'all',
    search: '',
    seenAlertIds: new Set(),
    initialized: false,
    loading: true,
    syncError: false,
    confirmCallback: null,
};

// Permissão de notificação do navegador na primeira interação
if ('Notification' in window && Notification.permission === 'default') {
    document.addEventListener('click', () => {
        if (Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }, { once: true });
}

function playAlertTone() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.setValueAtTime(440, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.14, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
    } catch (_) {}
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function showToast(title, message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `
        <span class="toast-dot" aria-hidden="true"></span>
        <div style="flex:1;min-width:0;">
            <strong style="display:block;font-size:13px;font-weight:600;color:#F8FAFC;margin-bottom:2px;">${escapeHtml(title)}</strong>
            <span style="font-size:12.5px;color:#94A3B8;display:block;line-height:1.4;">${escapeHtml(message)}</span>
        </div>
    `;
    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 150ms ease';
        setTimeout(() => el.remove(), 180);
    }, 4500);
}

/**
 * Formata datas "YYYY-MM-DD HH:MM:SS" para "29/10 às 19:23"
 */
function formatPtDate(raw) {
    if (!raw) return '—';
    const match = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (match) {
        const [, , month, day, hour, minute] = match;
        return `${day}/${month} às ${hour}:${minute}`;
    }
    return String(raw);
}

/**
 * Formata o intervalo real configurado em segundos
 */
function formatIntervalCompact(seconds) {
    const sec = Number(seconds || 3600);
    const min = Math.max(1, Math.round(sec / 60));
    if (min >= 60 && min % 60 === 0) {
        const h = min / 60;
        return `${h} ${h === 1 ? 'hora' : 'horas'}`;
    }
    return `${min} min`;
}

/**
 * Organiza diagnóstico e destino com hierarquia clara a partir dos dados reais da verificação
 */
function buildDiagnosisDisplay(d) {
    if (d.status === 'checking') {
        return {
            dotClass: 'diag-dot-checking',
            textClass: 'checking',
            primary: 'Verificando domínio...',
            secondary: d.reason || 'Consultando DNS e resposta HTTP',
            tooltip: d.reason || 'Verificando...',
        };
    }

    const reason = String(d.reason || '').trim();
    const httpInfo = d.http_code ? `HTTP ${d.http_code}` : '';
    const finalUrl = String(d.final_url || '').trim();
    const expected = String(d.expected_redirect || '').trim();

    if (d.status === 'online') {
        const primary = expected ? 'Destino esperado confirmado' : 'Destino acessível';
        const parts = [];
        if (httpInfo) parts.push(httpInfo);
        if (expected) {
            parts.push('Destino correto');
        } else if (finalUrl) {
            const cleanFinal = finalUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '');
            parts.push(`Destino: ${cleanFinal}`);
        } else {
            parts.push('Site ativo');
        }
        const secondary = parts.join(' · ');
        const fullTooltip = finalUrl
            ? `${reason} — URL final: ${finalUrl}`
            : reason;

        return {
            dotClass: 'diag-dot-online',
            textClass: 'online',
            primary,
            secondary,
            tooltip: fullTooltip,
        };
    }

    // Caso offline / Com problemas
    let primary = 'Indisponível';
    let secondary = reason || 'Falha na verificação do domínio';

    if (/423|Loja bloqueada/i.test(reason)) {
        primary = 'Loja indisponível na Shopify';
        secondary = 'HTTP 423 Locked · This store is unavailable';
    } else if (/DNS/i.test(reason)) {
        primary = 'DNS não encontrado';
        secondary = reason.includes('NXDOMAIN') ? 'Sem apontamento DNS ativo · NXDOMAIN' : reason;
    } else if (/Direcionamento incorreto/i.test(reason)) {
        primary = 'Destino diferente do esperado';
        secondary = reason;
    } else if (/estacionado|sem direcionamento|em branco|sem site/i.test(reason)) {
        primary = 'Sem direcionamento para loja ativa';
        secondary = httpInfo ? `${httpInfo} · ${reason}` : reason;
    } else if (/SSL|Certificado/i.test(reason)) {
        primary = 'Erro de certificado SSL';
        secondary = reason;
    } else if (/Timeout|Tempo limite/i.test(reason)) {
        primary = 'Tempo limite esgotado';
        secondary = 'O servidor não respondeu a tempo (Timeout)';
    } else if (/HTTP\s+\d+/i.test(reason)) {
        primary = httpInfo ? `Erro ${httpInfo}` : 'Erro HTTP';
        secondary = reason;
    }

    const fullTooltip = finalUrl ? `${reason} (URL: ${finalUrl})` : reason;

    return {
        dotClass: 'diag-dot-offline',
        textClass: 'offline',
        primary,
        secondary,
        tooltip: fullTooltip,
    };
}

async function dispatchBrowserEmailFallback(alertObj) {
    if (state.settings.smtp_pass) return { ok: true, mode: 'smtp' };
    if (!state.settings.email_notifications) return { ok: false, message: 'Notificações por e-mail desativadas.' };
    const rawRecipients = state.settings.notify_email || 'onobrecarlos@gmail.com, alertas.kloube@gmail.com';
    const recipients = rawRecipients.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    const messages = [];
    let anySuccess = false;
    for (const recipient of recipients) {
        try {
            const resp = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(recipient)}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    _subject: `[Kloube] Alerta de Domínio: ${alertObj.domain}`,
                    Loja: alertObj.name || alertObj.domain,
                    Dominio: alertObj.domain,
                    Status: 'Com problemas / Fora do ar',
                    Diagnostico: alertObj.reason,
                    Horario: alertObj.timestamp,
                }),
            });
            const resJson = await resp.json().catch(() => ({}));
            if (String(resJson.success).toLowerCase() === 'true') {
                anySuccess = true;
            } else if (resJson.message) {
                messages.push(`${recipient}: ${resJson.message}`);
            }
        } catch (_) {}
    }
    return { ok: anySuccess, messages };
}

function handleIncomingAlerts(alerts) {
    if (!Array.isArray(alerts)) return;

    if (!state.initialized) {
        alerts.forEach(a => state.seenAlertIds.add(a.id));
        state.initialized = true;
        return;
    }

    for (const a of alerts) {
        if (!state.seenAlertIds.has(a.id)) {
            state.seenAlertIds.add(a.id);
            playAlertTone();
            showToast(
                `Problema detectado: ${a.name || a.domain}`,
                `${a.reason}`,
                'error'
            );
            if ('Notification' in window && Notification.permission === 'granted') {
                new Notification(`Kloube: ${a.name || a.domain} fora do ar`, {
                    body: `${a.reason}\nAlerta enviado para ${a.email_recipient}`,
                });
            }
            dispatchBrowserEmailFallback(a);
        }
    }
}

function applyState(data) {
    if (!data) return;
    state.loading = false;
    state.syncError = false;
    if (Array.isArray(data.domains)) state.domains = data.domains;
    if (data.settings) state.settings = { ...state.settings, ...data.settings };
    if (Array.isArray(data.alerts)) {
        handleIncomingAlerts(data.alerts);
        state.alerts = data.alerts;
    }
    renderAll();
}

function getBrasiliaTimeHHMM() {
    try {
        return new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(new Date());
    } catch (_) {
        const now = new Date();
        return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }
}

let sessionAccessTime = getBrasiliaTimeHHMM();
let isAutoChecking = false;

async function runCheckAll(silent = false) {
    if (isAutoChecking) return;
    isAutoChecking = true;

    const btn = document.getElementById('btn-check-all');
    const icon = document.getElementById('check-all-icon');
    const label = document.getElementById('check-all-label');

    if (btn) btn.disabled = true;
    if (icon) icon.classList.add('spin');
    if (label) label.textContent = 'Verificando...';

    try {
        const res = await fetch('/api/check-all', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            applyState(data);
            sessionAccessTime = getBrasiliaTimeHHMM();
            const syncEl = document.getElementById('last-sync-text');
            if (syncEl) {
                syncEl.textContent = `Última verificação às ${sessionAccessTime}`;
            }
            if (!silent) {
                showToast('Verificação concluída', 'Todos os domínios foram atualizados.', 'success');
            }
        }
    } catch (_) {
        if (!silent) {
            showToast('Erro', 'Falha ao verificar os domínios.', 'error');
        }
    } finally {
        isAutoChecking = false;
        if (btn) btn.disabled = false;
        if (icon) icon.classList.remove('spin');
        if (label) label.textContent = 'Verificar agora';
    }
}

async function fetchState() {
    try {
        const res = await fetch('/api/state');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.ok) {
            applyState(data);
            const syncEl = document.getElementById('last-sync-text');
            if (syncEl) {
                syncEl.textContent = `Último acesso às ${sessionAccessTime}`;
            }
            if (data.needs_refresh && !isAutoChecking) {
                runCheckAll(true);
            }
        }
    } catch (err) {
        state.loading = false;
        state.syncError = true;
        renderConnectionBanner();
    }
}

function renderConnectionBanner() {
    const banner = document.getElementById('connection-error-banner');
    if (!banner) return;
    banner.style.display = state.syncError ? 'flex' : 'none';
}

function renderAll() {
    renderConnectionBanner();
    renderSummary();
    renderDomainsTable();
    renderAlerts();

    const emailDisplay = document.getElementById('header-email-display');
    if (emailDisplay) {
        emailDisplay.textContent = state.settings.notify_email || 'onobrecarlos@gmail.com, alertas.kloube@gmail.com';
    }

    const footerCheck = document.getElementById('footer-next-check');
    if (footerCheck) {
        footerCheck.textContent = `Intervalo configurado: ${formatIntervalCompact(state.settings.check_interval_seconds)}`;
    }
}

function renderSummary() {
    const total = state.domains.length;
    const online = state.domains.filter(d => d.status === 'online').length;
    const offline = state.domains.filter(d => d.status === 'offline').length;

    document.getElementById('stat-total').textContent = total;
    document.getElementById('stat-online').textContent = online;
    document.getElementById('stat-offline').textContent = offline;
    document.getElementById('stat-interval').textContent = formatIntervalCompact(state.settings.check_interval_seconds);
}

function renderDomainsTable() {
    const tableContainer = document.getElementById('domains-table-container');
    const tbody = document.getElementById('domains-tbody');
    const loadingState = document.getElementById('loading-state');
    const emptyState = document.getElementById('empty-state');
    const noResultsState = document.getElementById('no-results-state');

    if (state.loading) {
        tableContainer.style.display = 'none';
        loadingState.style.display = 'flex';
        emptyState.style.display = 'none';
        noResultsState.style.display = 'none';
        return;
    }

    loadingState.style.display = 'none';

    if (state.domains.length === 0) {
        tableContainer.style.display = 'none';
        emptyState.style.display = 'flex';
        noResultsState.style.display = 'none';
        tbody.innerHTML = '';
        return;
    }

    emptyState.style.display = 'none';

    const filtered = state.domains.filter(d => {
        if (state.filter === 'online' && d.status !== 'online') return false;
        if (state.filter === 'offline' && d.status !== 'offline') return false;
        if (state.search) {
            const q = state.search.toLowerCase();
            const matchDom = (d.domain || '').toLowerCase().includes(q);
            const matchName = (d.name || '').toLowerCase().includes(q);
            const matchReason = (d.reason || '').toLowerCase().includes(q);
            const matchUrl = (d.final_url || '').toLowerCase().includes(q);
            return matchDom || matchName || matchReason || matchUrl;
        }
        return true;
    });

    if (filtered.length === 0) {
        tableContainer.style.display = 'none';
        noResultsState.style.display = 'flex';
        tbody.innerHTML = '';
        return;
    }

    noResultsState.style.display = 'none';
    tableContainer.style.display = 'block';

    tbody.innerHTML = filtered.map(d => {
        const isOnline = d.status === 'online';
        const isChecking = d.status === 'checking';

        let badgeClass = 'status-badge-offline';
        let badgeLabel = 'Fora do ar';
        if (isOnline) {
            badgeClass = 'status-badge-online';
            badgeLabel = 'Online';
        } else if (isChecking) {
            badgeClass = 'status-badge-checking';
            badgeLabel = 'Verificando';
        }

        const diag = buildDiagnosisDisplay(d);
        const checkedLabel = isChecking ? 'Verificando...' : 'Verificado';
        const href = d.url || `https://${d.domain}`;
        const storeTitle = d.name && d.name.trim() ? d.name.trim() : d.domain;

        return `
            <tr data-id="${escapeHtml(d.id)}">
                <td>
                    <div class="store-cell">
                        <span class="store-name" title="${escapeHtml(storeTitle)}">${escapeHtml(storeTitle)}</span>
                        <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="store-domain-link" title="Abrir ${escapeHtml( href )} em nova aba">
                            <span>${escapeHtml(d.domain)}</span>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                                <polyline points="15 3 21 3 21 9"></polyline>
                                <line x1="10" y1="14" x2="21" y2="3"></line>
                            </svg>
                        </a>
                    </div>
                </td>
                <td>
                    <div class="diag-cell" title="${escapeHtml(diag.tooltip)}">
                        <span class="diag-dot ${diag.dotClass}" aria-hidden="true"></span>
                        <div class="diag-content">
                            <span class="diag-primary ${diag.textClass}">${escapeHtml(diag.primary)}</span>
                            <span class="diag-secondary">${escapeHtml(diag.secondary)}</span>
                        </div>
                    </div>
                </td>
                <td>
                    <span class="time-text">${checkedLabel}</span>
                </td>
                <td class="status-cell">
                    <span class="status-badge ${badgeClass}">
                        <span class="badge-dot" aria-hidden="true"></span>
                        <span>${badgeLabel}</span>
                    </span>
                </td>
                <td>
                    <div class="row-actions">
                        <button type="button" class="action-icon-btn" onclick="checkSingleDomain('${escapeHtml(d.id)}', this)" title="Verificar domínio agora" aria-label="Verificar ${escapeHtml(storeTitle)} agora">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                                <path d="M3 3v5h5"></path>
                                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
                                <path d="M16 16h5v5"></path>
                            </svg>
                        </button>
                        <button type="button" class="action-icon-btn" onclick="openEditModal('${escapeHtml(d.id)}')" title="Editar domínio" aria-label="Editar ${escapeHtml(storeTitle)}">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
                            </svg>
                        </button>
                        <button type="button" class="action-icon-btn action-delete" onclick="requestDeleteDomain('${escapeHtml(d.id)}')" title="Excluir domínio" aria-label="Excluir ${escapeHtml(storeTitle)}">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function renderAlerts() {
    const container = document.getElementById('alerts-list');
    if (!container) return;

    if (!state.alerts || state.alerts.length === 0) {
        container.innerHTML = `
            <div class="alerts-empty">
                Nenhum alerta registrado até o momento.
            </div>
        `;
        return;
    }

    container.innerHTML = state.alerts.map(a => {
        const storeName = escapeHtml(a.name && a.name.trim() ? a.name.trim() : a.domain);
        const timeStr = formatPtDate(a.timestamp);

        return `
            <div class="alert-card">
                <div class="alert-card-left">
                    <div class="alert-icon-box" aria-hidden="true">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
                            <line x1="12" y1="9" x2="12" y2="13"></line>
                            <line x1="12" y1="17" x2="12.01" y2="17"></line>
                        </svg>
                    </div>
                    <div class="alert-info">
                        <div class="alert-store-title">${storeName}</div>
                        <div class="alert-problem-desc">Bloqueou em ${escapeHtml(timeStr)}</div>
                    </div>
                </div>
                <div class="alert-card-right">
                    <span class="alert-timestamp" title="${escapeHtml(a.timestamp || '')}">${escapeHtml(timeStr)}</span>
                </div>
            </div>
        `;
    }).join('');
}

// ==========================================
// Controle de Modais e Acessibilidade
// ==========================================
function openModal(modalId, focusSelector) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.style.display = 'flex';
    if (focusSelector) {
        setTimeout(() => {
            const target = modal.querySelector(focusSelector);
            if (target) target.focus();
        }, 40);
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.style.display = 'none';
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        ['add-modal', 'edit-modal', 'confirm-modal', 'settings-modal', 'create-account-modal'].forEach(closeModal);
    }
});

['add-modal', 'edit-modal', 'confirm-modal', 'settings-modal', 'create-account-modal'].forEach(id => {
    const backdrop = document.getElementById(id);
    if (backdrop) {
        backdrop.addEventListener('mousedown', (e) => {
            if (e.target === backdrop) closeModal(id);
        });
    }
});

// ==========================================
// 4. Cadastro de Domínio (Modal)
// ==========================================
function openAddModal() {
    document.getElementById('add-form-error').style.display = 'none';
    document.getElementById('input-domain').value = '';
    document.getElementById('input-name').value = '';
    document.getElementById('input-redirect').value = '';
    openModal('add-modal', '#input-domain');
}

document.getElementById('btn-open-add').addEventListener('click', openAddModal);
document.getElementById('btn-empty-add').addEventListener('click', openAddModal);
document.getElementById('btn-close-add').addEventListener('click', () => closeModal('add-modal'));
document.getElementById('btn-cancel-add').addEventListener('click', () => closeModal('add-modal'));

document.getElementById('add-domain-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('add-form-error');
    const domainInput = document.getElementById('input-domain');
    const nameInput = document.getElementById('input-name');
    const redirectInput = document.getElementById('input-redirect');
    const submitBtn = document.getElementById('btn-submit-add');

    const domain = domainInput.value.trim();
    if (!domain || !domain.includes('.')) {
        errorBox.textContent = 'Informe um domínio válido (exemplo: www.sualoja.com.br).';
        errorBox.style.display = 'block';
        domainInput.focus();
        return;
    }

    errorBox.style.display = 'none';
    submitBtn.disabled = true;
    const prevText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<span>Verificando e salvando...</span>';

    try {
        const res = await fetch('/api/domains', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                domain,
                name: nameInput.value.trim(),
                expected_redirect: redirectInput.value.trim(),
            }),
        });
        const data = await res.json();
        if (!data.ok) {
            errorBox.textContent = data.error || 'Não foi possível adicionar o domínio.';
            errorBox.style.display = 'block';
            return;
        }

        closeModal('add-modal');
        applyState(data.state);
        const added = data.domain;
        if (added && added.status === 'online') {
            showToast('Domínio adicionado', `${added.name || added.domain} está online.`, 'success');
        } else if (added) {
            showToast('Domínio adicionado com alerta', `${added.domain}: ${added.reason}`, 'error');
        }
    } catch (_) {
        errorBox.textContent = 'Falha de comunicação com o servidor local.';
        errorBox.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = prevText;
    }
});

// ==========================================
// Edição de Domínio (Modal)
// ==========================================
window.openEditModal = function(domainId) {
    const d = state.domains.find(item => item.id === domainId);
    if (!d) return;

    document.getElementById('edit-form-error').style.display = 'none';
    document.getElementById('edit-id').value = d.id;
    document.getElementById('edit-domain').value = d.domain;
    document.getElementById('edit-name').value = (d.name && d.name !== d.domain) ? d.name : (d.name || '');
    document.getElementById('edit-redirect').value = d.expected_redirect || '';
    openModal('edit-modal', '#edit-domain');
};

document.getElementById('btn-close-edit').addEventListener('click', () => closeModal('edit-modal'));
document.getElementById('btn-cancel-edit').addEventListener('click', () => closeModal('edit-modal'));

document.getElementById('edit-domain-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('edit-form-error');
    const id = document.getElementById('edit-id').value;
    const domain = document.getElementById('edit-domain').value.trim();
    const name = document.getElementById('edit-name').value.trim();
    const expected_redirect = document.getElementById('edit-redirect').value.trim();
    const submitBtn = document.getElementById('btn-submit-edit');

    if (!domain || !domain.includes('.')) {
        errorBox.textContent = 'Informe um endereço de domínio válido.';
        errorBox.style.display = 'block';
        return;
    }

    errorBox.style.display = 'none';
    submitBtn.disabled = true;
    const prevText = submitBtn.textContent;
    submitBtn.textContent = 'Salvando...';

    try {
        const res = await fetch(`/api/domains/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain, name, expected_redirect }),
        });
        const data = await res.json();
        if (!data.ok) {
            errorBox.textContent = data.error || 'Não foi possível atualizar o domínio.';
            errorBox.style.display = 'block';
            return;
        }
        closeModal('edit-modal');
        applyState(data.state);
        showToast('Alterações salvas', `${data.domain.name || data.domain.domain} foi revalidado.`, 'success');
    } catch (_) {
        errorBox.textContent = 'Erro ao salvar as alterações.';
        errorBox.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = prevText;
    }
});

// ==========================================
// Modal de Confirmação (Exclusão & Limpeza)
// ==========================================
function askConfirmation({ title, description, confirmLabel = 'Confirmar', onConfirm }) {
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-desc').textContent = description;
    const acceptBtn = document.getElementById('btn-accept-confirm');
    acceptBtn.textContent = confirmLabel;
    state.confirmCallback = onConfirm;
    openModal('confirm-modal', '#btn-accept-confirm');
}

document.getElementById('btn-close-confirm').addEventListener('click', () => closeModal('confirm-modal'));
document.getElementById('btn-cancel-confirm').addEventListener('click', () => closeModal('confirm-modal'));
document.getElementById('btn-accept-confirm').addEventListener('click', async () => {
    const fn = state.confirmCallback;
    closeModal('confirm-modal');
    if (typeof fn === 'function') {
        await fn();
    }
});

window.requestDeleteDomain = function(domainId) {
    const d = state.domains.find(item => item.id === domainId);
    if (!d) return;
    const label = d.name && d.name !== d.domain ? `${d.name} (${d.domain})` : d.domain;

    askConfirmation({
        title: 'Excluir domínio',
        description: `Tem certeza que deseja remover "${label}" do monitoramento? Esta ação não pode ser desfeita.`,
        confirmLabel: 'Excluir domínio',
        onConfirm: async () => {
            try {
                const res = await fetch(`/api/domains/${encodeURIComponent(domainId)}`, {
                    method: 'DELETE',
                });
                const data = await res.json();
                if (data.ok) {
                    applyState(data.state);
                    showToast('Domínio removido', `${d.domain} foi excluído.`, 'info');
                }
            } catch (_) {
                showToast('Erro', 'Não foi possível excluir o domínio.', 'error');
            }
        },
    });
};

const clearAlertsBtnEl = document.getElementById('btn-clear-alerts');
if (clearAlertsBtnEl) {
    clearAlertsBtnEl.addEventListener('click', () => {
        if (!state.alerts || state.alerts.length === 0) return;
        askConfirmation({
            title: 'Limpar histórico de alertas',
            description: 'Deseja remover todos os registros do histórico de alertas? Os domínios monitorados continuarão ativos.',
            confirmLabel: 'Limpar histórico',
            onConfirm: async () => {
                try {
                    const res = await fetch('/api/clear-alerts', { method: 'POST' });
                    const data = await res.json();
                    if (data.ok) {
                        applyState(data);
                        showToast('Histórico limpo', 'Os registros de alertas foram removidos.', 'info');
                    }
                } catch (_) {
                    showToast('Erro', 'Não foi possível limpar o histórico.', 'error');
                }
            },
        });
    });
}

// ==========================================
// Verificação Individual e Geral
// ==========================================
window.checkSingleDomain = async function(domainId, btnEl) {
    if (btnEl) {
        btnEl.disabled = true;
        const svg = btnEl.querySelector('svg');
        if (svg) svg.classList.add('spin');
    }
    try {
        const res = await fetch(`/api/domains/${encodeURIComponent(domainId)}/check`, {
            method: 'POST',
        });
        const data = await res.json();
        if (data.ok) {
            applyState(data.state);
            sessionAccessTime = getBrasiliaTimeHHMM();
            const syncEl = document.getElementById('last-sync-text');
            if (syncEl) {
                syncEl.textContent = `Última verificação às ${sessionAccessTime}`;
            }
            if (data.domain && data.domain.status === 'online') {
                showToast('Verificação concluída', `${data.domain.name || data.domain.domain} está online.`, 'success');
            }
        }
    } catch (_) {
        showToast('Erro na consulta', 'Não foi possível verificar o domínio.', 'error');
    } finally {
        if (btnEl) {
            btnEl.disabled = false;
            const svg = btnEl.querySelector('svg');
            if (svg) svg.classList.remove('spin');
        }
    }
};

document.getElementById('btn-check-all').addEventListener('click', () => runCheckAll(false));

// ==========================================
// Configurações & Teste de Notificação
// ==========================================
document.getElementById('btn-open-settings').addEventListener('click', () => {
    document.getElementById('set-email').value = state.settings.notify_email || 'onobrecarlos@gmail.com, alertas.kloube@gmail.com';
    const intervalSelect = document.getElementById('set-interval');
    const currentSec = String(state.settings.check_interval_seconds || 3600);
    if ([...intervalSelect.options].some(o => o.value === currentSec)) {
        intervalSelect.value = currentSec;
    } else {
        intervalSelect.value = '3600';
    }
    document.getElementById('set-desktop').checked = state.settings.desktop_notifications !== false;
    document.getElementById('set-email-toggle').checked = state.settings.email_notifications !== false;
    document.getElementById('set-smtp-user').value = state.settings.smtp_user || 'growthnobre@gmail.com';
    document.getElementById('set-smtp-pass').value = state.settings.smtp_pass || '';
    openModal('settings-modal', '#set-email');
});

document.getElementById('btn-close-settings').addEventListener('click', () => closeModal('settings-modal'));
document.getElementById('btn-cancel-settings').addEventListener('click', () => closeModal('settings-modal'));

document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const saveBtn = document.getElementById('btn-save-settings');
    saveBtn.disabled = true;

    const payload = {
        notify_email: document.getElementById('set-email').value.trim() || 'onobrecarlos@gmail.com, alertas.kloube@gmail.com',
        check_interval_seconds: Number(document.getElementById('set-interval').value || 3600),
        desktop_notifications: document.getElementById('set-desktop').checked,
        email_notifications: document.getElementById('set-email-toggle').checked,
        smtp_user: document.getElementById('set-smtp-user').value.trim() || 'growthnobre@gmail.com',
        smtp_pass: document.getElementById('set-smtp-pass').value.trim(),
    };

    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.ok) {
            applyState(data);
            closeModal('settings-modal');
            showToast('Configurações salvas', `Intervalo definido para ${formatIntervalCompact(payload.check_interval_seconds)}.`, 'success');
        }
    } catch (_) {
        showToast('Erro', 'Não foi possível salvar as configurações.', 'error');
    } finally {
        saveBtn.disabled = false;
    }
});

async function triggerTestNotification(btnEl) {
    if (btnEl) btnEl.disabled = true;
    try {
        state.initialized = true;
        const res = await fetch('/api/test-notification', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            const alertObj = data.alert;
            if (alertObj && !state.seenAlertIds.has(alertObj.id)) {
                state.seenAlertIds.add(alertObj.id);
            }
            applyState(data.state);
            playAlertTone();
            if (alertObj && alertObj.email_sent) {
                showToast('Alerta de teste enviado!', `${alertObj.email_info}`, 'success');
            } else if (alertObj) {
                const fb = await dispatchBrowserEmailFallback(alertObj);
                if (fb && fb.ok) {
                    showToast('Alerta de teste disparado!', `Notificação no PC + e-mail enviado para ${state.settings.notify_email}.`, 'success');
                } else if (fb && fb.messages && fb.messages.length > 0) {
                    showToast('Ação necessária no e-mail', fb.messages.join(' | '), 'info');
                } else {
                    showToast('Falta Senha de App SMTP', 'O alerta no PC funcionou! Para envio direto no Gmail, configure a Senha de App (16 letras) em Configurações.', 'info');
                }
            }
        }
    } catch (_) {
        showToast('Erro', 'Falha ao enviar notificação de teste.', 'error');
    } finally {
        if (btnEl) btnEl.disabled = false;
    }
}

document.getElementById('btn-test-alert').addEventListener('click', (e) => triggerTestNotification(e.currentTarget));
document.getElementById('btn-modal-test-alert').addEventListener('click', (e) => triggerTestNotification(e.currentTarget));

// ==========================================
// Filtros, Busca e Reconexão
// ==========================================
document.querySelectorAll('.segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.segment-btn').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        state.filter = btn.getAttribute('data-filter') || 'all';
        renderDomainsTable();
    });
});

document.getElementById('search-input').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    renderDomainsTable();
});

document.getElementById('btn-clear-filters').addEventListener('click', () => {
    state.filter = 'all';
    state.search = '';
    document.getElementById('search-input').value = '';
    document.querySelectorAll('.segment-btn').forEach(b => {
        const isAll = b.getAttribute('data-filter') === 'all';
        b.classList.toggle('active', isAll);
        b.setAttribute('aria-selected', isAll ? 'true' : 'false');
    });
    renderDomainsTable();
});

document.getElementById('btn-retry-sync').addEventListener('click', fetchState);

// ==========================================
// Autenticação (Login / Trocar Senha / Criar Conta Admin / Sair)
// ==========================================
const AUTH_STORAGE_KEY = 'kloube_auth_user_v1';
const ADMIN_EMAIL_ADDR = 'onobrecarlos@gmail.com';

function updateAdminVisibility() {
    const savedUser = (localStorage.getItem(AUTH_STORAGE_KEY) || '').trim().toLowerCase();
    const createAccountBtn = document.getElementById('btn-open-create-account');
    if (createAccountBtn) {
        createAccountBtn.style.display = (savedUser === ADMIN_EMAIL_ADDR) ? 'inline-flex' : 'none';
    }
}

function checkAuthSession() {
    const authScreen = document.getElementById('auth-screen');
    if (!authScreen) return;
    const savedUser = localStorage.getItem(AUTH_STORAGE_KEY);
    updateAdminVisibility();
    if (savedUser) {
        authScreen.style.display = 'none';
    } else {
        authScreen.style.display = 'flex';
        showLoginView();
    }
}

function showLoginView() {
    document.getElementById('auth-login-view').style.display = 'block';
    document.getElementById('auth-reset-view').style.display = 'none';
    document.getElementById('login-error-box').style.display = 'none';
}

function showResetView(prefillEmail = '') {
    const authScreen = document.getElementById('auth-screen');
    const savedUser = localStorage.getItem(AUTH_STORAGE_KEY) || '';
    const isAlreadyLoggedIn = Boolean(savedUser);

    authScreen.style.display = 'flex';
    document.getElementById('auth-login-view').style.display = 'none';
    document.getElementById('auth-reset-view').style.display = 'block';
    document.getElementById('reset-error-box').style.display = 'none';

    const sendCodeBtn = document.getElementById('btn-send-reset-code');
    const codeGroup = document.getElementById('reset-code-group');
    const subtitleEl = document.getElementById('auth-reset-subtitle');
    if (isAlreadyLoggedIn) {
        if (sendCodeBtn) sendCodeBtn.style.display = 'none';
        if (codeGroup) codeGroup.style.display = 'none';
        if (subtitleEl) subtitleEl.textContent = 'Defina abaixo a sua nova senha de acesso.';
    } else {
        if (sendCodeBtn) sendCodeBtn.style.display = 'inline-flex';
        if (codeGroup) codeGroup.style.display = 'flex';
        if (subtitleEl) subtitleEl.textContent = 'Clique em "Enviar código" para receber o código de 6 dígitos no seu e-mail.';
    }

    const emailField = document.getElementById('reset-email');
    emailField.value = prefillEmail || document.getElementById('login-email').value.trim() || savedUser || '';
    document.getElementById('reset-code').value = '';
    document.getElementById('reset-new-password').value = '';
    document.getElementById('reset-confirm-password').value = '';
    setTimeout(() => {
        if (emailField.value && isAlreadyLoggedIn) {
            document.getElementById('reset-new-password').focus();
        } else {
            emailField.focus();
        }
    }, 40);
}

document.getElementById('btn-forgot-password').addEventListener('click', () => {
    showResetView(document.getElementById('login-email').value.trim());
});

document.getElementById('btn-back-to-login').addEventListener('click', () => {
    const savedUser = localStorage.getItem(AUTH_STORAGE_KEY);
    if (savedUser) {
        document.getElementById('auth-screen').style.display = 'none';
    } else {
        showLoginView();
    }
});

document.getElementById('btn-header-change-pass').addEventListener('click', () => {
    showResetView(localStorage.getItem(AUTH_STORAGE_KEY) || '');
});

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    document.getElementById('login-password').value = '';
    checkAuthSession();
    showToast('Sessão encerrada', 'Você saiu do painel Kloube.', 'info');
});

document.getElementById('btn-send-reset-code').addEventListener('click', async () => {
    const errorBox = document.getElementById('reset-error-box');
    const email = document.getElementById('reset-email').value.trim();
    const btn = document.getElementById('btn-send-reset-code');

    if (!email) {
        errorBox.textContent = 'Digite o seu e-mail cadastrado antes de pedir o código.';
        errorBox.style.display = 'block';
        document.getElementById('reset-email').focus();
        return;
    }

    errorBox.style.display = 'none';
    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = 'Enviando...';

    try {
        const res = await fetch('/api/auth/send-reset-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        });
        const data = await res.json();
        if (!data.ok) {
            errorBox.textContent = data.error || 'Não foi possível enviar o código.';
            errorBox.style.display = 'block';
            return;
        }
        showToast('Código enviado!', data.message || 'Verifique a caixa de entrada do seu e-mail.', 'success');
        document.getElementById('reset-code').focus();
    } catch (_) {
        errorBox.textContent = 'Erro ao solicitar código de verificação.';
        errorBox.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = prevText;
    }
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('login-error-box');
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value.trim();
    const submitBtn = document.getElementById('btn-login-submit');

    if (!email || !password) {
        errorBox.textContent = 'Preencha o seu e-mail e a sua senha.';
        errorBox.style.display = 'block';
        return;
    }

    errorBox.style.display = 'none';
    submitBtn.disabled = true;
    const prevHtml = submitBtn.innerHTML;
    submitBtn.innerHTML = '<span>Entrando...</span>';

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!data.ok) {
            errorBox.textContent = data.error || 'E-mail ou senha inválidos.';
            errorBox.style.display = 'block';
            return;
        }
        localStorage.setItem(AUTH_STORAGE_KEY, data.user.email);
        sessionAccessTime = getBrasiliaTimeHHMM();
        const syncEl = document.getElementById('last-sync-text');
        if (syncEl) syncEl.textContent = `Último acesso às ${sessionAccessTime}`;
        updateAdminVisibility();
        document.getElementById('auth-screen').style.display = 'none';
        showToast('Bem-vindo!', `Acesso liberado para ${data.user.email}.`, 'success');
    } catch (_) {
        errorBox.textContent = 'Erro ao conectar com o servidor local.';
        errorBox.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = prevHtml;
    }
});

document.getElementById('reset-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('reset-error-box');
    const email = document.getElementById('reset-email').value.trim();
    const code = document.getElementById('reset-code').value.trim();
    const newPassword = document.getElementById('reset-new-password').value.trim();
    const confirmPassword = document.getElementById('reset-confirm-password').value.trim();
    const submitBtn = document.getElementById('btn-reset-submit');
    const loggedInUser = localStorage.getItem(AUTH_STORAGE_KEY) || '';

    if (!email) {
        errorBox.textContent = 'Informe o e-mail cadastrado.';
        errorBox.style.display = 'block';
        return;
    }
    if (!loggedInUser && !code) {
        errorBox.textContent = 'Informe o código de 6 dígitos enviado para o seu e-mail.';
        errorBox.style.display = 'block';
        return;
    }
    if (newPassword.length < 4) {
        errorBox.textContent = 'A nova senha deve ter pelo menos 4 caracteres.';
        errorBox.style.display = 'block';
        return;
    }
    if (newPassword !== confirmPassword) {
        errorBox.textContent = 'As senhas digitadas não conferem.';
        errorBox.style.display = 'block';
        return;
    }

    errorBox.style.display = 'none';
    submitBtn.disabled = true;
    const prevHtml = submitBtn.innerHTML;
    submitBtn.innerHTML = '<span>Salvando...</span>';

    try {
        const res = await fetch('/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email,
                code,
                new_password: newPassword,
                logged_in_user: loggedInUser,
            }),
        });
        const data = await res.json();
        if (!data.ok) {
            errorBox.textContent = data.error || 'Não foi possível alterar a senha.';
            errorBox.style.display = 'block';
            return;
        }
        localStorage.setItem(AUTH_STORAGE_KEY, data.user.email);
        sessionAccessTime = getBrasiliaTimeHHMM();
        const syncEl = document.getElementById('last-sync-text');
        if (syncEl) syncEl.textContent = `Último acesso às ${sessionAccessTime}`;
        updateAdminVisibility();
        document.getElementById('auth-screen').style.display = 'none';
        showToast('Senha atualizada!', data.message || 'Sua nova senha já está ativa.', 'success');
    } catch (_) {
        errorBox.textContent = 'Erro ao conectar com o servidor local.';
        errorBox.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = prevHtml;
    }
});

// ==========================================
// Criar Conta de Acesso (Exclusivo onobrecarlos@gmail.com)
// ==========================================
document.getElementById('btn-open-create-account').addEventListener('click', () => {
    document.getElementById('create-account-error').style.display = 'none';
    document.getElementById('new-account-email').value = '';
    document.getElementById('new-account-password').value = '';
    openModal('create-account-modal', '#new-account-email');
});

document.getElementById('btn-close-create-account').addEventListener('click', () => closeModal('create-account-modal'));
document.getElementById('btn-cancel-create-account').addEventListener('click', () => closeModal('create-account-modal'));

document.getElementById('create-account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('create-account-error');
    const newEmail = document.getElementById('new-account-email').value.trim();
    const newPassword = document.getElementById('new-account-password').value.trim();
    const submitBtn = document.getElementById('btn-submit-create-account');
    const requesterEmail = localStorage.getItem(AUTH_STORAGE_KEY) || '';

    if (!newEmail || !newEmail.includes('@')) {
        errorBox.textContent = 'Informe um endereço de e-mail válido.';
        errorBox.style.display = 'block';
        return;
    }
    if (newPassword.length < 4) {
        errorBox.textContent = 'A senha inicial deve ter pelo menos 4 caracteres.';
        errorBox.style.display = 'block';
        return;
    }

    errorBox.style.display = 'none';
    submitBtn.disabled = true;
    const prevHtml = submitBtn.innerHTML;
    submitBtn.innerHTML = '<span>Criando conta...</span>';

    try {
        const res = await fetch('/api/auth/create-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requester_email: requesterEmail,
                new_email: newEmail,
                new_password: newPassword,
            }),
        });
        const data = await res.json();
        if (!data.ok) {
            errorBox.textContent = data.error || 'Não foi possível criar a conta.';
            errorBox.style.display = 'block';
            return;
        }
        closeModal('create-account-modal');
        showToast('Conta criada com sucesso!', `O acesso para ${data.created_email} já está liberado.`, 'success');
    } catch (_) {
        errorBox.textContent = 'Falha ao conectar com o servidor local.';
        errorBox.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = prevHtml;
    }
});

// Inicialização
checkAuthSession();
fetchState();
setInterval(fetchState, 10000);
