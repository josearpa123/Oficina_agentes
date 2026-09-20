import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createState, EVENT_TYPES } from './state.js';
import { openDb } from './db.js';
import { loadConfig } from '../lib/config.js';
import { startCopilotWatcher } from './watchers/copilot.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'web');
const dataDir = process.env.AGENT_OFFICE_DATA || path.join(root, 'data');
const config = loadConfig();
const port = Number(process.env.PORT || config.port || 4317);
const host = process.env.HOST || config.host || '127.0.0.1';

// Token: variable de entorno o data/token.txt (se genera la primera vez).
fs.mkdirSync(dataDir, { recursive: true });
const tokenFile = path.join(dataDir, 'token.txt');
let token = process.env.AGENT_OFFICE_TOKEN || '';
if (!token) {
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { /* primera vez */ }
  if (!token) { token = crypto.randomBytes(18).toString('hex'); fs.writeFileSync(tokenFile, token); }
}
const tokenBuf = Buffer.from(token);
function authorized(req, url) {
  const given = Buffer.from(String(req.headers['x-token'] || url.searchParams.get('token') || ''));
  return given.length === tokenBuf.length && crypto.timingSafeEqual(given, tokenBuf);
}

const db = await openDb(path.join(dataDir, 'office.db'));
const state = createState(config, { totals: db ? () => db.totals() : undefined });
const clients = new Set();

let pending = false;
function broadcast() {
  if (pending) return; // agrupa ráfagas de eventos (máx ~10 envíos/s)
  pending = true;
  setTimeout(() => {
    pending = false;
    const msg = `event: state\ndata: ${JSON.stringify(state.snapshot())}\n\n`;
    for (const res of clients) res.write(msg);
  }, 100);
}

setInterval(() => { if (state.tick()) broadcast(); }, 5000);
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

// Punto único de entrada de eventos: lo usan la API HTTP y los vigilantes internos.
function ingest(ev) {
  const { entry, usage } = state.apply(ev);
  if (db) {
    try { if (entry) db.insert(entry); if (usage) db.addUsage(usage); } catch { /* el historial nunca debe romper el monitoreo */ }
  }
  broadcast();
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req, url)) return json(res, 401, { error: 'token inválido' });

    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state.snapshot());
    if (req.method === 'GET' && url.pathname === '/api/history') return json(res, 200, db ? db.recent(url.searchParams.get('limit')) : []);

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(state.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/event') {
      let ev;
      try { ev = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'JSON inválido' }); }
      if (!ev || typeof ev.agent !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(ev.agent)) return json(res, 400, { error: 'agent inválido' });
      if (!EVENT_TYPES.includes(ev.type)) return json(res, 400, { error: `type debe ser uno de: ${EVENT_TYPES.join(', ')}` });
      ev.agent = ev.agent.toLowerCase();
      ingest(ev);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'no encontrado' });
  }

  // Estáticos (no contienen datos; la API exige token)
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(webDir, rel);
  if (!file.startsWith(webDir + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('no encontrado'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

server.listen(port, host, () => {
  console.log(`\n  Oficina de agentes lista\n  → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/?token=${token}\n`);
  // Vigilantes: detectan agentes que no se conectan solos (Copilot CLI no tiene hooks).
  if (config.watchers?.copilot !== false) {
    startCopilotWatcher({ emit: ingest, home: process.env.AGENT_OFFICE_HOME || undefined });
    console.log('  Vigilante de Copilot CLI activo');
  }
});
