#!/usr/bin/env node
// Wrapper genérico: ejecuta cualquier CLI de agente (Gemini, Copilot, otro) y reporta su estado.
//
//   node connectors/run-agent.js --agent gemini --dept marketing --task "Landing copy" -- gemini -p "escribe el copy"
//   node connectors/run-agent.js --agent copilot --scan -- copilot -p "arregla los tests"
//
//  --scan   lee la salida del proceso (solo para modo headless -p): muestra la última línea como
//           "acción" y detecta límites de cuota. Sin --scan el agente conserva el terminal interactivo
//           y solo se reportan inicio y fin.
import { spawn } from 'node:child_process';
import { report } from '../lib/report.js';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1 || sep === argv.length - 1) {
  console.error('Uso: run-agent.js --agent <nombre> [--dept <id>] [--project <n>] [--task <t>] [--scan] -- <comando> [args]');
  process.exit(2);
}
const opts = {};
for (let i = 0; i < sep; i++) {
  const k = argv[i].replace(/^--/, '');
  opts[k] = k === 'scan' ? true : argv[++i];
}
const [cmd, ...cmdArgs] = argv.slice(sep + 1);
if (!opts.agent) { console.error('Falta --agent'); process.exit(2); }
// En modo no interactivo (-p / --prompt) la salida se puede leer sin romper el terminal: activa --scan solo.
if (!opts.scan && cmdArgs.some((a) => a === '-p' || a === '--prompt' || a.startsWith('--prompt='))) opts.scan = true;

const session = `${opts.agent}-${process.pid}`;
const base = { agent: opts.agent, session, cwd: process.cwd(), dept: opts.dept, project: opts.project };
const LIMIT_RE = /rate.?limit|quota|usage limit|too many requests|resource[_ ]exhausted|limit reached|\b429\b/i;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

await report({ ...base, type: 'session_start', text: 'wrapper' });
await report({ ...base, type: 'task', text: opts.task || [cmd, ...cmdArgs].join(' ').slice(0, 120) });

const quote = (s) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
const child = process.platform === 'win32'
  ? spawn([cmd, ...cmdArgs].map(quote).join(' '), { shell: true, stdio: opts.scan ? ['inherit', 'pipe', 'pipe'] : 'inherit' })
  : spawn(cmd, cmdArgs, { stdio: opts.scan ? ['inherit', 'pipe', 'pipe'] : 'inherit' });

let limitHit = false;
let lastSent = 0;
if (opts.scan) {
  const onData = (out) => (chunk) => {
    out.write(chunk);
    const lines = stripAnsi(chunk.toString()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const hit = lines.find((l) => LIMIT_RE.test(l));
    if (hit && !limitHit) { limitHit = true; report({ ...base, type: 'limit', text: hit.slice(0, 120) }); return; }
    const now = Date.now();
    if (now - lastSent > 1500) { lastSent = now; report({ ...base, type: 'action', text: lines[lines.length - 1].slice(0, 80) }); }
  };
  child.stdout.on('data', onData(process.stdout));
  child.stderr.on('data', onData(process.stderr));
}

child.on('error', async (e) => { await report({ ...base, type: 'session_end', text: e.message }); process.exit(127); });
child.on('exit', async (code) => {
  if (!limitHit) await report({ ...base, type: 'idle', text: code === 0 ? 'terminó' : `terminó con código ${code}` });
  // Si hubo límite, el agente queda marcado como "sin tokens" un momento antes de salir de escena.
  await new Promise((r) => setTimeout(r, limitHit ? 4000 : 500));
  await report({ ...base, type: 'session_end', text: '' });
  process.exit(code ?? 1);
});
