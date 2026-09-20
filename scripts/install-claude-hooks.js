// Instala (o quita con --remove) los hooks de Claude Code en ~/.claude/settings.json.
// Hace copia de seguridad, es idempotente y no toca ningún otro hook.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const remove = process.argv.includes('--remove');
const hookPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'claude-hook.js').replace(/\\/g, '/');
const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
const command = `node "${hookPath}"`;

const EVENTS = { SessionStart: null, UserPromptSubmit: null, PreToolUse: '*', Notification: null, Stop: null, SessionEnd: null };
const isOurs = (h) => typeof h?.command === 'string' && h.command.includes('claude-hook.js');

let settings = {};
if (fs.existsSync(settingsFile)) {
  const text = fs.readFileSync(settingsFile, 'utf8');
  try { settings = JSON.parse(text); } catch { console.error(`No pude leer ${settingsFile} (JSON inválido). No se modificó nada.`); process.exit(1); }
  fs.writeFileSync(`${settingsFile}.bak-agent-office`, text);
}

settings.hooks ??= {};
for (const [event, matcher] of Object.entries(EVENTS)) {
  const groups = (settings.hooks[event] ??= []);
  // limpia nuestras entradas previas
  for (const g of groups) g.hooks = (g.hooks || []).filter((h) => !isOurs(h));
  settings.hooks[event] = groups.filter((g) => g.hooks?.length);
  if (!remove) {
    const group = { hooks: [{ type: 'command', command }] };
    if (matcher) group.matcher = matcher;
    settings.hooks[event].push(group);
  }
  if (!settings.hooks[event].length) delete settings.hooks[event];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

// Línea de estado (tokens y uso del plan). Solo con --statusline; nunca pisa una línea de estado ajena.
const statusCommand = `node "${hookPath.replace('claude-hook.js', 'claude-statusline.js')}"`;
const ourStatus = typeof settings.statusLine?.command === 'string' && settings.statusLine.command.includes('claude-statusline.js');
let statusNote = '';
if (remove) {
  if (ourStatus) { delete settings.statusLine; statusNote = ' Línea de estado eliminada.'; }
} else if (process.argv.includes('--statusline')) {
  if (settings.statusLine && !ourStatus) {
    statusNote = `\nYa tienes otra línea de estado configurada; no la toqué: ${JSON.stringify(settings.statusLine)}`;
  } else {
    settings.statusLine = { type: 'command', command: statusCommand };
    statusNote = ' Línea de estado instalada (tokens y uso del plan).';
  }
}

fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
console.log((remove ? 'Hooks de la oficina eliminados.' : `Hooks instalados en ${settingsFile}\n(copia previa: settings.json.bak-agent-office). Reinicia las sesiones abiertas de Claude Code.`) + statusNote);
