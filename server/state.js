// Estado en memoria de la oficina: quién trabaja, dónde, en qué proyecto y con qué tarea.

export const EVENT_TYPES = ['session_start', 'task', 'action', 'idle', 'notify', 'limit', 'usage', 'session_end'];

const TTL = { working: 30 * 60e3, idle: 30 * 60e3, waiting: 30 * 60e3, exhausted: 3 * 3600e3 };
const WORKING_STALE = 3 * 60e3; // sin eventos en 3 min → pasa a "libre"
const FALLBACK_COLORS = ['#7dd3c0', '#f28b82', '#c3e88d', '#82aaff', '#ffcb6b'];

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v) => (Number.isFinite(+v) && +v >= 0 ? +v : 0);
const pct = (v) => Math.min(100, num(v));

// totals(): () => { [agent]: { today: {tin,tout,cost}, week: {tin,tout,cost} } } (viene del historial SQLite)
export function createState(config, { totals } = {}) {
  const agents = new Map();
  const quotas = new Map(); // cuotas de plan reportadas por el propio agente (p. ej. ventanas de 5 h / semanal)
  const feed = [];
  const deptIds = new Set(config.departments.map((d) => d.id));
  const routes = (config.routes || []).map((r) => ({ re: new RegExp(r.cwd, 'i'), dept: r.dept }));
  const projects = (config.projects || []).map((p) => ({ name: p.name, path: norm(p.path).toLowerCase() }));

  // Prioridad de sala: explícita > tarea (texto del pedido) > carpeta > defecto del agente.
  function resolveDept(agentKey, cwd) {
    const c = norm(cwd);
    if (c) for (const r of routes) if (r.re.test(c + '/') && deptIds.has(r.dept)) return { dept: r.dept, by: 'carpeta' };
    const def = config.agents?.[agentKey]?.dept;
    return { dept: deptIds.has(def) ? def : config.departments[0].id, by: 'defecto' };
  }

  // Sala según los últimos mensajes (el más reciente pesa más, así "sigue" no borra el tema de la sesión).
  // Gana la sala con más coincidencias; en empate, la que va primero en config.
  const taskRoutes = (config.taskRoutes || []).filter((r) => deptIds.has(r.dept)).map((r) => ({ dept: r.dept, re: new RegExp(r.match, 'g') }));
  const WEIGHTS = [3, 2, 1, 1];
  function deptFromTask(texts) {
    const score = new Map();
    texts.slice(0, WEIGHTS.length).forEach((text, i) => {
      const t = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      for (const r of taskRoutes) {
        const n = (t.match(r.re) || []).length;
        if (n) score.set(r.dept, (score.get(r.dept) || 0) + n * WEIGHTS[i]);
      }
    });
    let best = null, top = 0;
    for (const [d, s] of score) if (s > top) { best = d; top = s; }
    return best;
  }

  function resolveProject(cwd) {
    const c = norm(cwd);
    if (!c) return 'Sin proyecto';
    const lc = c.toLowerCase();
    const hit = projects.filter((p) => lc === p.path || lc.startsWith(p.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
    return hit ? hit.name : c.split('/').pop() || 'Sin proyecto';
  }

  // limits: [{ id, label, usedPct, resetsAt(ms), detail?, asOf?(ms) }]. asOf = cuándo se midió (si no es "ahora").
  function setQuota(agentKey, limits, now) {
    if (!Array.isArray(limits)) return;
    quotas.set(agentKey, {
      updatedAt: now,
      limits: limits.slice(0, 4).map((l) => ({
        id: clip(l.id, 20), label: clip(l.label || l.id, 12), usedPct: pct(l.usedPct), resetsAt: num(l.resetsAt) || null,
        detail: clip(l.detail, 30), asOf: num(l.asOf) || now,
      })),
    });
  }

  function setStatus(a, status, now) {
    if (a.status !== status) { a.status = status; a.since = now; }
  }

  function apply(ev) {
    const now = Date.now();
    const agentKey = ev.agent;
    const key = `${agentKey}:${ev.session || 'main'}`;
    // Solo cuota del plan (sin sesión): no crea ningún agente en la oficina.
    if (ev.type === 'usage' && ev.quotaOnly) { setQuota(agentKey, ev.limits, now); return { entry: null, usage: null }; }
    let a = agents.get(key);
    const cwd = ev.cwd ? norm(ev.cwd) : undefined;
    if (!a) {
      const cfg = config.agents?.[agentKey];
      const r = resolveDept(agentKey, cwd);
      a = {
        id: key, agent: agentKey,
        name: cfg?.name || agentKey,
        color: cfg?.color || FALLBACK_COLORS[[...agentKey].reduce((s, c) => s + c.charCodeAt(0), 0) % FALLBACK_COLORS.length],
        dept: r.dept, deptBy: r.by, project: resolveProject(cwd),
        status: 'idle', task: '', taskHistory: [], action: '', since: now, firstSeen: now, lastSeen: now, resetAt: null, cwd: cwd || '',
      };
      agents.set(key, a);
    }
    a.lastSeen = now;
    if (cwd && cwd !== a.cwd) {
      a.cwd = cwd; a.project = resolveProject(cwd);
      if (a.deptBy !== 'explícita') { const r = resolveDept(agentKey, cwd); a.dept = r.dept; a.deptBy = r.by; }
    }
    if (ev.dept && deptIds.has(ev.dept)) { a.dept = ev.dept; a.deptBy = 'explícita'; }
    if (ev.project) a.project = clip(ev.project, 40);

    const text = clip(ev.text, 300);
    switch (ev.type) {
      case 'session_start': setStatus(a, 'idle', now); a.action = ''; break;
      case 'task': {
        setStatus(a, 'working', now); a.task = text; a.action = ''; a.resetAt = null;
        // El pedido manda sobre la carpeta; si no dice nada claro (p. ej. "sigue"), conserva la sala actual.
        // Historial (más reciente primero). `ev.history` permite sembrarlo con mensajes anteriores a que nos conectáramos.
        const older = Array.isArray(ev.history) ? ev.history.map((h) => clip(h, 200)) : a.taskHistory;
        a.taskHistory = [text, ...older].slice(0, WEIGHTS.length);
        const d = a.deptBy === 'explícita' ? null : deptFromTask(a.taskHistory);
        if (d) { a.dept = d; a.deptBy = 'tarea'; }
        break;
      }
      case 'action': setStatus(a, 'working', now); a.action = text; a.resetAt = null; break;
      case 'idle': setStatus(a, 'idle', now); a.action = text; break;
      case 'notify': setStatus(a, 'waiting', now); a.action = text; break;
      case 'limit': setStatus(a, 'exhausted', now); a.action = text; a.resetAt = ev.resetAt ? Number(ev.resetAt) || null : null; break;
      case 'session_end': agents.delete(key); break;
      case 'usage': {
        const u = ev.usage || {};
        a.usage = {
          tin: num(u.tokensIn), tout: num(u.tokensOut), cost: num(u.costUsd),
          ctxPct: u.ctxPct == null ? null : pct(u.ctxPct), model: clip(u.model, 30),
        };
        if (Array.isArray(ev.limits)) setQuota(agentKey, ev.limits, now);
        // No es actividad visible: no entra al feed ni cambia el estado.
        return { entry: null, usage: { session: key, agent: agentKey, ...a.usage } };
      }
    }

    const entry = { ts: now, id: key, agent: agentKey, name: a.name, color: a.color, dept: a.dept, project: a.project, type: ev.type, text };
    feed.push(entry);
    if (feed.length > 200) feed.shift();
    return { entry, usage: null };
  }

  // Envejece estados: trabajo sin señales → libre; sesiones muertas → fuera.
  function tick() {
    const now = Date.now();
    let changed = false;
    for (const [key, a] of agents) {
      const age = now - a.lastSeen;
      if (age > TTL[a.status]) { agents.delete(key); changed = true; }
      else if (a.status === 'working' && age > WORKING_STALE) { setStatus(a, 'idle', now); changed = true; }
      else if (a.status === 'exhausted' && a.resetAt && now > a.resetAt) { setStatus(a, 'idle', now); a.resetAt = null; changed = true; }
    }
    return changed;
  }

  function snapshot() {
    const now = Date.now();
    const list = [...agents.values()].map((a) => ({ ...a, ageMs: now - a.lastSeen, statusMs: now - a.since }));
    const counts = new Map();
    for (const a of list) counts.set(a.project, (counts.get(a.project) || 0) + 1);
    // Cuotas por agente: lo que reporta el agente + presupuesto diario opcional (config.budgets, marcado como estimado).
    const tot = totals ? totals() : {};
    const nextMidnight = new Date(); nextMidnight.setHours(24, 0, 0, 0);
    const quotasOut = {};
    for (const k of new Set([...Object.keys(config.agents || {}), ...list.map((a) => a.agent), ...quotas.keys()])) {
      const rep = quotas.get(k);
      const limits = (rep?.limits || []).filter((l) => !l.resetsAt || l.resetsAt > now); // ventana vencida = dato viejo
      const cap = num(config.budgets?.[k]?.tokensPerDay);
      const today = tot[k]?.today;
      if (cap && today) limits.push({ id: 'budget', label: 'HOY', usedPct: pct(((today.tin + today.tout) / cap) * 100), resetsAt: nextMidnight.getTime(), estimated: true });
      quotasOut[k] = { limits, tokens: tot[k] || null, reported: !!rep };
    }
    return {
      config: { departments: config.departments, agents: config.agents },
      quotas: quotasOut,
      agents: list.sort((x, y) => x.firstSeen - y.firstSeen),
      projects: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      feed: feed.slice(-40).reverse(),
    };
  }

  return { apply, tick, snapshot };
}
