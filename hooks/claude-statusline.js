#!/usr/bin/env node
// Línea de estado de Claude Code → oficina. Claude Code envía por stdin el consumo de la sesión y, si tienes
// plan Pro/Max, el uso de tus ventanas de 5 h y semanal. Reportamos eso y devolvemos un texto corto para la barra.
import { report } from '../lib/report.js';

const fmtPct = (v) => `${Math.round(v)}%`;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  let line = '';
  try {
    const h = JSON.parse(raw || '{}');
    const cw = h.context_window || {};
    const rl = h.rate_limits || {};

    const limits = [];
    if (rl.five_hour) limits.push({ id: 'five_hour', label: '5H', usedPct: rl.five_hour.used_percentage, resetsAt: (rl.five_hour.resets_at || 0) * 1000 });
    if (rl.seven_day) limits.push({ id: 'seven_day', label: 'SEMANA', usedPct: rl.seven_day.used_percentage, resetsAt: (rl.seven_day.resets_at || 0) * 1000 });
    if (rl.spend_limit) limits.push({ id: 'spend_limit', label: 'GASTO', usedPct: rl.spend_limit.used_percentage, resetsAt: (rl.spend_limit.resets_at || 0) * 1000 });

    const parts = [];
    if (rl.five_hour) parts.push(`5h ${fmtPct(rl.five_hour.used_percentage)}`);
    if (rl.seven_day) parts.push(`sem ${fmtPct(rl.seven_day.used_percentage)}`);
    if (cw.used_percentage != null) parts.push(`ctx ${fmtPct(cw.used_percentage)}`);
    line = parts.join(' · ');

    await report({
      agent: 'claude',
      session: h.session_id,
      cwd: h.workspace?.current_dir || h.cwd || process.cwd(),
      type: 'usage',
      usage: {
        tokensIn: cw.total_input_tokens,
        tokensOut: cw.total_output_tokens,
        costUsd: h.cost?.total_cost_usd,
        ctxPct: cw.used_percentage,
        model: h.model?.display_name,
      },
      ...(rl.five_hour || rl.seven_day || rl.spend_limit ? { limits } : {}),
    });
  } catch { /* la barra de estado nunca debe fallar */ }
  process.stdout.write(line);
  process.exit(0);
});
