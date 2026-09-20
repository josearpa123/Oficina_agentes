// Carga la configuración: config.json (tuyo, local, no se sube a git) o, si no existe, config.example.json.
// También se puede apuntar a otro archivo con la variable AGENT_OFFICE_CONFIG.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  const candidates = [process.env.AGENT_OFFICE_CONFIG, path.join(root, 'config.json'), path.join(root, 'config.example.json')].filter(Boolean);
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new Error('No encuentro config.json ni config.example.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
