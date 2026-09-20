// Simula agentes trabajando para ver la oficina sin conectar nada real.  Ctrl+C para salir.
import { report } from '../lib/report.js';

const cast = [
  { agent: 'claude', session: 'demo-1', cwd: 'C:/demo/tienda/api', project: 'Tienda Online', tasks: ['Crear endpoint de pagos', 'Migrar tabla de usuarios'], actions: ['editando payments.ts', 'leyendo schema.sql', '$ npm test', 'buscando UserModel', 'creando migration.sql'] },
  { agent: 'claude', session: 'demo-2', cwd: 'C:/demo/tienda/web', project: 'Tienda Online', tasks: ['Carrito responsive'], actions: ['editando Cart.tsx', 'editando cart.css', '$ npm run lint', 'leyendo Header.tsx'] },
  { agent: 'gemini', session: 'demo-3', cwd: 'C:/demo/landing/marketing', project: 'Landing Verano', tasks: ['Copy de la campaña', 'Ideas de posts'], actions: ['redactando titular', 'analizando competencia', 'escribiendo email'] },
  { agent: 'copilot', session: 'demo-4', cwd: 'C:/demo/tienda/tests', project: 'Tienda Online', tasks: ['Tests e2e de checkout'], actions: ['editando checkout.spec.ts', '$ npx playwright test', 'leyendo fixtures'] },
  { agent: 'gemini', session: 'demo-5', cwd: 'C:/demo/app/qa', project: 'App Móvil', tasks: ['Plan de pruebas'], actions: ['listando casos', 'editando plan.md'] },
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

for (const c of cast) await report({ agent: c.agent, session: c.session, cwd: c.cwd, project: c.project, type: 'session_start', text: '' });

console.log('Demo en marcha. Ctrl+C para salir. (Ojo: si usas el servidor real, estos consumos falsos quedan en tus totales; usa AGENT_OFFICE_DATA para aislarlo.)');
const counters = new Map();
setInterval(async () => {
  const c = pick(cast);
  const base = { agent: c.agent, session: c.session, cwd: c.cwd, project: c.project };
  const k = counters.get(c.session) || { tin: 0, tout: 0, cost: 0 };
  k.tin += Math.floor(Math.random() * 4000); k.tout += Math.floor(Math.random() * 900); k.cost += Math.random() * 0.03;
  counters.set(c.session, k);
  await report({
    ...base, type: 'usage',
    usage: { tokensIn: k.tin, tokensOut: k.tout, costUsd: c.agent === 'claude' ? k.cost : 0, ctxPct: Math.min(95, k.tin / 3000) },
    ...(c.agent === 'claude' ? { limits: [
      { id: 'five_hour', label: '5H', usedPct: Math.min(100, 20 + k.tin / 2500), resetsAt: Date.now() + 2.2 * 3600e3 },
      { id: 'seven_day', label: 'SEMANA', usedPct: 74, resetsAt: Date.now() + 3.5 * 86400e3 },
    ] } : {}),
  });
  const r = Math.random();
  if (r < 0.12) await report({ ...base, type: 'task', text: pick(c.tasks) });
  else if (r < 0.2) await report({ ...base, type: 'idle', text: 'turno terminado' });
  else if (r < 0.25) await report({ ...base, type: 'notify', text: 'necesita permiso' });
  else if (r < 0.28 && c.agent === 'gemini') await report({ ...base, type: 'limit', text: 'quota exceeded', resetAt: Date.now() + 60_000 });
  else await report({ ...base, type: 'action', text: pick(c.actions) });
}, 1200);

process.on('SIGINT', async () => {
  for (const c of cast) await report({ agent: c.agent, session: c.session, type: 'session_end', text: '' });
  process.exit(0);
});
