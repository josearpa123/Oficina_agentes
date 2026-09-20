import { createOffice } from './office.js';

// ---------- Conexión ----------
const params = new URLSearchParams(location.search);
let token = params.get('token') || localStorage.getItem('ao_token') || '';
if (!token) token = prompt('Token de la oficina (está en data/token.txt):') || '';
if (token) localStorage.setItem('ao_token', token);
if (params.has('token')) history.replaceState(null, '', location.pathname);

let model = { config: { departments: [], agents: {} }, agents: [], projects: [], feed: [], quotas: {} };
let receivedAt = Date.now();
let projectFilter = null;
let room = null; // sala visible en móvil
const connEl = document.getElementById('conn');
const mq = window.matchMedia('(max-width: 700px)');
const statusMs = (a) => a.statusMs + (Date.now() - receivedAt);

const office = createOffice(document.getElementById('office'), {
  model: () => model, filter: () => projectFilter, single: () => mq.matches, room: () => room, statusMs,
});

function connect() {
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
  es.addEventListener('state', (e) => {
    model = JSON.parse(e.data);
    receivedAt = Date.now();
    connEl.textContent = 'en vivo'; connEl.className = 'conn on';
    if (projectFilter && !model.projects.some((p) => p.name === projectFilter)) projectFilter = null;
    const ids = model.config.departments.map((d) => d.id);
    if (!ids.includes(room)) room = (model.config.departments.find((d) => model.agents.some((a) => a.dept === d.id && a.status === 'working')) || model.config.departments[0])?.id || null;
    office.layout(); office.tick(); renderDom();
  });
  es.onerror = () => { connEl.textContent = 'sin conexión'; connEl.className = 'conn off'; };
}
connect();

// ---------- Paneles DOM ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { working: 'Trabajando', idle: 'Libre', waiting: 'Esperando', exhausted: 'Sin tokens' };
function ago(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0)));
const fmtCost = (c) => (c ? '$' + c.toFixed(c < 1 ? 3 : 2) : '');
function until(ts) {
  const m = Math.max(0, Math.round((ts - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

function renderQuotas() {
  const q = model.quotas || {};
  const ids = Object.keys(q);
  document.getElementById('quotas').innerHTML = ids.map((id) => {
    const cfg = model.config.agents[id] || {};
    const c = q[id];
    const live = model.agents.filter((a) => a.agent === id);
    const sess = live.reduce((s, a) => s + (a.usage ? a.usage.tin + a.usage.tout : 0), 0);
    const t = c.tokens || {};
    const tok = (x) => (x ? fmtTok(x.tin + x.tout) : '0');
    const nums = (live.length === 1 ? '1 sesión activa' : `${live.length} sesiones activas`) +
      (sess ? ` · sesiones: <b>${fmtTok(sess)}</b>` : '') +
      (t.today ? ` · hoy: <b>${tok(t.today)}</b>${t.today.cost ? ' (' + fmtCost(t.today.cost) + ')' : ''}` : '') +
      (t.week ? ` · 7 días: <b>${tok(t.week)}</b>` : '');
    const lims = c.limits.map((l) => {
      const cls = l.usedPct >= 90 ? 'high' : l.usedPct >= 70 ? 'mid' : '';
      return `<div class="lim"><span>${esc(l.label)}${l.estimated ? '*' : ''}</span>
        <div class="bar ${cls}"><i style="width:${l.usedPct}%"></i></div><span>${Math.round(l.usedPct)}% usado</span>
        <em>quedan ${Math.max(0, Math.round(100 - l.usedPct))}%${l.detail ? ' · ' + esc(l.detail) : ''}${l.resetsAt ? ' · renueva en ' + until(l.resetsAt) : ''}${l.estimated ? ' · estimado' : ''}${l.asOf && Date.now() - l.asOf > 600000 ? ' · medido hace ' + ago(Date.now() - l.asOf) : ''}</em></div>`;
    }).join('') || `<div class="none">${live.length || t.today ? 'Este agente no informa cuánto plan te queda.' : 'Sin datos todavía.'}</div>`;
    return `<section class="quota" style="--c:${esc(cfg.color || '#8a90b5')}"><div class="qh">${esc(cfg.name || id)}<span>${c.reported ? (c.limits.some((l) => !l.asOf || Date.now() - l.asOf < 600000) ? 'datos del plan en vivo' : 'última medición guardada') : ''}</span></div>
      <div class="nums">${nums}</div>${lims}</section>`;
  }).join('');
}

function renderRooms() {
  document.getElementById('rooms').innerHTML = model.config.departments.map((d) => {
    const list = model.agents.filter((a) => a.dept === d.id);
    const active = list.some((a) => a.status === 'working');
    return `<button style="--c:${esc(d.color)}" aria-pressed="${room === d.id}" data-r="${esc(d.id)}">${active ? '<i class="pulse"></i>' : ''}${esc(d.name)}<small>${list.length}</small></button>`;
  }).join('');
}

function renderDom() {
  renderQuotas();
  renderRooms();
  // proyectos
  const nav = document.getElementById('projects');
  const total = model.agents.length;
  nav.innerHTML = `<button aria-pressed="${!projectFilter}" data-p="">Todos<small>${total}</small></button>` +
    model.projects.map((p) => `<button aria-pressed="${projectFilter === p.name}" data-p="${esc(p.name)}">${esc(p.name)}<small>${p.count}</small></button>`).join('');

  // departamentos
  document.getElementById('depts').innerHTML = model.config.departments.map((d) => {
    const list = model.agents.filter((a) => a.dept === d.id);
    const active = list.filter((a) => a.status === 'working').length;
    const rows = list.map((a) => {
      const dim = projectFilter && a.project !== projectFilter;
      return `<div class="agent ${a.status}${dim ? ' dim' : ''}">
        <div class="top"><span class="dot"></span><span class="nm" style="color:${esc(a.color)}">${esc(a.name)}</span>
          <span class="chip">${esc(a.project)}</span><span class="chip" title="Cómo se eligió esta sala">sala: ${esc(a.deptBy || '')}</span><span class="st">${STATUS[a.status] || a.status} · ${ago(statusMs(a))}</span></div>
        ${a.usage && (a.usage.tin || a.usage.tout) ? `<div class="act"><span class="chip use">${fmtTok(a.usage.tin)} in · ${fmtTok(a.usage.tout)} out${a.usage.cost ? ' · ' + fmtCost(a.usage.cost) : ''}${a.usage.ctxPct != null ? ' · ctx ' + Math.round(a.usage.ctxPct) + '%' : ''}</span></div>` : ''}
        ${a.task ? `<div class="task">${esc(a.task)}</div>` : ''}
        ${a.action ? `<div class="act">› ${esc(a.action)}</div>` : ''}
      </div>`;
    }).join('') || '<div class="empty">Sin agentes conectados</div>';
    return `<section class="dept" style="--c:${esc(d.color)}"><div class="head">${esc(d.name)}<span>${active} activos · ${list.length} total</span></div>${rows}</section>`;
  }).join('');

  // feed
  document.getElementById('feed').innerHTML = model.feed.map((e) =>
    `<li><time>${new Date(e.ts).toLocaleTimeString('es', { hour12: false })}</time><b style="color:${esc(e.color)}">${esc(e.name)}</b><span>${esc(e.text || e.type)}</span></li>`).join('');
}

// ---------- Interacción ----------
document.getElementById('projects').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  projectFilter = b.dataset.p || null;
  renderDom();
});

function goRoom(id) { room = id; office.layout(); office.tick(); renderRooms(); }
document.getElementById('rooms').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) goRoom(b.dataset.r);
});

// Deslizar sobre la oficina cambia de sala (móvil)
let touchX = null;
const stage = document.querySelector('.stage');
stage.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
stage.addEventListener('touchend', (e) => {
  if (touchX == null || !mq.matches) return;
  const dx = e.changedTouches[0].clientX - touchX; touchX = null;
  if (Math.abs(dx) < 50) return;
  const ids = model.config.departments.map((d) => d.id);
  const i = ids.indexOf(room);
  if (i >= 0) goRoom(ids[(i + (dx < 0 ? 1 : -1) + ids.length) % ids.length]);
}, { passive: true });

mq.addEventListener('change', () => { office.layout(); office.tick(); });

setInterval(renderDom, 1000);   // refresca los "hace X" sin depender de eventos
setInterval(() => office.tick(), 50);
office.layout();

// ---------- App Android: botón para cambiar de servidor (solo existe dentro de la app) ----------
if (window.OficinaApp) {
  const b = document.createElement('button');
  b.className = 'server-btn'; b.textContent = 'Servidor'; b.title = 'Cambiar el enlace del servidor';
  b.onclick = () => window.OficinaApp.reset();
  document.querySelector('header').append(b);
}

// ---------- App instalable (PWA) ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* sin SW sigue funcionando */ });
