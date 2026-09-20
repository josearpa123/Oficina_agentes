// Vigilante de Copilot CLI. Copilot no tiene hooks, pero deja en disco:
//   ~/.copilot/logs/process-<inicio_ms>-<pid>.log      → menciona el id de la sesión que corre ese proceso
//   ~/.copilot/session-state/<id>/events.jsonl         → cada mensaje, herramienta y turno, en vivo
// Con eso sabemos qué procesos copilot.exe hay, en qué carpeta trabajan y qué están haciendo,
// aunque los abras directamente con `copilot`. Solo lee archivos locales; no toca nada.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LIMIT_RE = /quota|rate.?limit|too many requests|exhaust|premium request|usage limit/i;
const MAX_INITIAL_READ = 8 * 1024 * 1024;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const base = (p) => (p ? path.basename(String(p)) : '');

function describeTool(name, a = {}) {
  switch (name) {
    case 'report_intent': return clip(a.intent, 60);
    case 'view': return `leyendo ${base(a.path)}`;
    case 'edit': return `editando ${base(a.path)}`;
    case 'create': return `creando ${base(a.path)}`;
    case 'apply_patch': return 'aplicando parche';
    case 'powershell': case 'bash': return `$ ${clip(a.command, 58)}`;
    case 'grep': case 'rg': return `buscando ${clip(a.pattern, 30)}`;
    case 'glob': return `listando ${clip(a.pattern, 30)}`;
    case 'task': return `subagente: ${clip(a.description || a.name, 40)}`;
    case 'skill': return `skill ${clip(a.skill, 40)}`;
    default: return clip(name, 40);
  }
}

// PIDs de copilot.exe vivos (Windows). En otros sistemas no hay vigilante todavía.
function alivePids() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(new Set());
    execFile('tasklist', ['/FI', 'IMAGENAME eq copilot.exe', '/FO', 'CSV', '/NH'], { timeout: 4000, windowsHide: true }, (err, out) => {
      const pids = new Set();
      if (!err) for (const m of String(out).matchAll(/^"copilot\.exe","(\d+)"/gim)) pids.add(Number(m[1]));
      resolve(err ? null : pids); // null = no se pudo consultar: no tocar nada este ciclo
    });
  });
}

export function startCopilotWatcher({ emit, home = os.homedir(), intervalMs = 2000 } = {}) {
  const logsDir = path.join(home, '.copilot', 'logs');
  const sessDir = path.join(home, '.copilot', 'session-state');
  const procs = new Map(); // pid → estado del vigilante para ese proceso

  const send = (p, type, text, extra = {}) => emit({ agent: 'copilot', session: p.session, cwd: p.cwd || undefined, type, text, ...extra });

  function logFiles() {
    const map = new Map();
    try {
      for (const f of fs.readdirSync(logsDir)) {
        const m = f.match(/^process-(\d+)-(\d+)\.log$/);
        if (m) map.set(Number(m[2]), { file: path.join(logsDir, f), start: Number(m[1]) });
      }
    } catch { /* aún no existe */ }
    return map;
  }

  // ¿Qué sesión corre este proceso? La última UUID del log que sea una carpeta de sesión existente.
  function sessionOf(logFile) {
    let text;
    try {
      const st = fs.statSync(logFile);
      const fd = fs.openSync(logFile, 'r');
      const len = Math.min(st.size, 512 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch { return null; }
    const ids = text.match(UUID) || [];
    // events.jsonl aparece con el primer mensaje; la carpeta de la sesión existe desde que se abre Copilot.
    for (let i = ids.length - 1; i >= 0; i--) {
      if (fs.existsSync(path.join(sessDir, ids[i]))) return ids[i];
    }
    return null;
  }

  function cwdOf(sid) {
    try {
      const y = fs.readFileSync(path.join(sessDir, sid, 'workspace.yaml'), 'utf8');
      const m = y.match(/^cwd:\s*(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch { /* sin yaml todavía */ }
    return '';
  }

  function attach(p, sid) {
    p.sid = sid;
    p.file = path.join(sessDir, sid, 'events.jsonl');
    p.offset = 0; p.rest = ''; p.first = true;
    p.task = ''; p.msgs = []; p.action = ''; p.inTurn = false; p.tools = new Map(); p.tin = 0; p.tout = 0;
    p.cwd = cwdOf(sid) || p.cwd;
  }

  function handle(p, ev, live) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'session.start': if (d.context?.cwd) p.cwd = d.context.cwd; break;
      case 'user.message':
        p.task = clip(d.content, 200);
        p.msgs.unshift(p.task); p.msgs.length = Math.min(p.msgs.length, 4);
        if (live) send(p, 'task', p.task);
        break;
      case 'assistant.turn_start':
        p.inTurn = true;
        if (live) send(p, 'action', 'pensando...');
        break;
      case 'assistant.turn_end': case 'abort':
        p.inTurn = false;
        if (live) send(p, 'idle', ev.type === 'abort' ? 'cancelado' : 'turno terminado');
        break;
      case 'tool.execution_start': {
        p.tools.set(d.toolCallId, d.toolName);
        p.action = describeTool(d.toolName, d.arguments && typeof d.arguments === 'object' ? d.arguments : {});
        if (!live) break;
        if (d.toolName === 'ask_user') send(p, 'notify', `pregunta: ${clip(d.arguments?.question, 50)}`);
        else send(p, 'action', p.action);
        break;
      }
      case 'tool.execution_complete':
        if (live && p.tools.get(d.toolCallId) === 'ask_user') send(p, 'action', 'respuesta recibida');
        p.tools.delete(d.toolCallId);
        break;
      case 'session.error': {
        const msg = clip(d.message, 100);
        if (!live) break;
        if (d.statusCode === 429 || LIMIT_RE.test(msg)) send(p, 'limit', msg || 'límite alcanzado');
        else send(p, 'action', `error ${d.statusCode || ''} ${msg}`.trim());
        break;
      }
      case 'model.model_call_success': {
        const u = d.responseUsage;
        if (u) { p.tin += u.prompt_tokens || 0; p.tout += u.completion_tokens || 0; }
        const q = d.quotaSnapshots?.premium_interactions;
        const limits = q && !q.isUnlimitedEntitlement ? [premiumLimit(q, Date.parse(ev.timestamp) || Date.now())] : undefined;
        if (live && (u || limits)) send(p, 'usage', '', { usage: { tokensIn: p.tin, tokensOut: p.tout }, ...(limits ? { limits } : {}) });
        break;
      }
      case 'session.shutdown': {
        const models = Object.values(d.modelMetrics || {});
        const tin = models.reduce((s, m) => s + (m.usage?.inputTokens || 0), 0);
        const tout = models.reduce((s, m) => s + (m.usage?.outputTokens || 0), 0);
        if (live && (tin || tout)) send(p, 'usage', '', { usage: { tokensIn: tin, tokensOut: tout } });
        break;
      }
    }
  }

  function premiumLimit(q, asOf) {
    return {
      id: 'premium', label: 'PREMIUM', usedPct: Math.max(0, 100 - (q.remainingPercentage ?? 100)),
      resetsAt: Date.parse(q.resetDate) || 0, detail: `${q.usedRequests}/${q.entitlementRequests} solicitudes`, asOf,
    };
  }

  function readNew(p) {
    let st;
    // Sin events.jsonl aún (sesión recién abierta, sin mensajes): ya sabemos carpeta/proyecto; lo leemos cuando aparezca.
    try { st = fs.statSync(p.file); } catch { if (p.first) finishInitial(p); return; }
    if (st.size < p.offset) { p.offset = 0; p.rest = ''; }
    if (p.first && st.size > MAX_INITIAL_READ) { p.offset = st.size - MAX_INITIAL_READ; p.rest = ''; p.skipPartial = true; }
    if (st.size === p.offset) { if (p.first) finishInitial(p); return; }
    const len = st.size - p.offset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p.file, 'r');
    fs.readSync(fd, buf, 0, len, p.offset);
    fs.closeSync(fd);
    p.offset = st.size;
    const lines = (p.rest + buf.toString('utf8')).split('\n');
    p.rest = lines.pop(); // última línea posiblemente incompleta
    if (p.skipPartial) { lines.shift(); p.skipPartial = false; }
    const live = !p.first;
    for (const line of lines) {
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      handle(p, ev, live);
    }
    if (p.first) finishInitial(p);
  }

  // Primera lectura de una sesión: reconstruimos el estado actual sin inundar el feed con el historial.
  function finishInitial(p) {
    p.first = false;
    // history = mensajes anteriores (más reciente primero) para decidir la sala con el tema de toda la sesión.
    if (p.task) send(p, 'task', p.task, { history: p.msgs.slice(1) });
    if (p.inTurn) send(p, 'action', p.action || 'trabajando');
    else send(p, 'idle', p.task ? 'esperando tu siguiente mensaje' : 'sin actividad todavía');
  }

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const alive = await alivePids();
      if (alive === null) return;
      for (const [pid, p] of procs) {
        if (!alive.has(pid)) { send(p, 'session_end', 'cerrado'); procs.delete(pid); }
      }
      if (!alive.size) return;
      const logs = logFiles();
      for (const pid of alive) {
        const lg = logs.get(pid);
        let p = procs.get(pid);
        if (!p) {
          p = { pid, session: `p${pid}-${(lg?.start || 0).toString(36)}`, cwd: '', sid: null, file: null };
          procs.set(pid, p);
          send(p, 'session_start', 'detectado');
        }
        if (lg) {
          const sid = sessionOf(lg.file);
          if (sid && sid !== p.sid) attach(p, sid);
        }
        if (p.file) readNew(p);
      }
    } catch { /* un fallo del vigilante nunca debe afectar al servidor */ } finally { busy = false; }
  }

  // Cuota del plan: la última medición guardada en cualquier sesión previa (dato con su fecha, no "en vivo").
  function seedQuota() {
    try {
      const dirs = fs.readdirSync(sessDir).map((d) => ({ d, f: path.join(sessDir, d, 'events.jsonl') }))
        .filter((x) => fs.existsSync(x.f)).map((x) => ({ ...x, m: fs.statSync(x.f) }))
        .filter((x) => x.m.size < 30 * 1024 * 1024).sort((a, b) => b.m.mtimeMs - a.m.mtimeMs).slice(0, 40);
      for (const { f } of dirs) {
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"quotaSnapshots"'));
        for (let i = lines.length - 1; i >= 0; i--) {
          let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
          const q = ev.data?.quotaSnapshots?.premium_interactions;
          if (q && !q.isUnlimitedEntitlement && Date.parse(q.resetDate) > Date.now()) {
            emit({ agent: 'copilot', type: 'usage', quotaOnly: true, limits: [premiumLimit(q, Date.parse(ev.timestamp) || Date.now())] });
            return;
          }
        }
      }
    } catch { /* sin datos previos */ }
  }

  seedQuota();
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), _procs: procs };
}
