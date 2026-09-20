// Cliente compartido: envía un evento al servidor de la oficina.
// Nunca lanza ni bloquea: si el servidor está apagado, simplemente no pasa nada.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readToken() {
  if (process.env.AGENT_OFFICE_TOKEN) return process.env.AGENT_OFFICE_TOKEN;
  try { return fs.readFileSync(path.join(root, 'data', 'token.txt'), 'utf8').trim(); } catch { return ''; }
}

export function report(event, { timeout = 700 } = {}) {
  const url = new URL(process.env.AGENT_OFFICE_URL || 'http://127.0.0.1:4317');
  const body = JSON.stringify(event);
  return new Promise((resolve) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: '/api/event',
      method: 'POST',
      timeout,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-token': readToken(),
      },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end(body);
  });
}
