#!/usr/bin/env node
// Hook de Claude Code → oficina. Lee el JSON del hook por stdin y reporta un evento.
// Debe ser rápido y nunca bloquear ni fallar: siempre sale con código 0 sin imprimir nada.
import path from 'node:path';
import { report } from '../lib/report.js';

const base = (p) => (p ? path.basename(String(p)) : '');
const first = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function describeTool(name, input = {}) {
  switch (name) {
    case 'Bash': return `$ ${first(input.command)}`;
    case 'Read': return `leyendo ${base(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `editando ${base(input.file_path)}`;
    case 'Write': return `creando ${base(input.file_path)}`;
    case 'Grep': return `buscando ${first(input.pattern, 30)}`;
    case 'Glob': return `listando ${first(input.pattern, 30)}`;
    case 'Task': case 'Agent': return `subagente: ${first(input.description, 40)}`;
    case 'WebFetch': case 'WebSearch': return `web: ${first(input.url || input.query, 40)}`;
    default: return first(name, 40);
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  try {
    const h = JSON.parse(raw || '{}');
    const map = {
      SessionStart: { type: 'session_start', text: h.source || '' },
      UserPromptSubmit: { type: 'task', text: first(h.prompt, 200) },
      PreToolUse: { type: 'action', text: describeTool(h.tool_name, h.tool_input) },
      Notification: { type: 'notify', text: first(h.message, 80) || 'necesita atención' },
      Stop: { type: 'idle', text: 'turno terminado' },
      SessionEnd: { type: 'session_end', text: h.reason || '' },
    };
    const m = map[h.hook_event_name];
    if (m) {
      await report({
        agent: 'claude',
        session: h.session_id,
        cwd: h.cwd || process.cwd(),
        dept: process.env.AGENT_DEPT || undefined,
        ...m,
      });
    }
  } catch (e) { if (process.env.AGENT_OFFICE_DEBUG) console.error(e); }
  process.exit(0);
});
