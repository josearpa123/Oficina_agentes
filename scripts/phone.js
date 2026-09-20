// Asistente para abrir la oficina en tu celular.
//   npm run phone                → revisa Tailscale (recomendado) y te dice qué falta; si ya está listo, imprime el QR
//   npm run phone -- --setup     → además publica la oficina en tu red privada de Tailscale (tailscale serve)
//   npm run phone -- --lan       → alternativa sin Tailscale: misma red Wi-Fi (menos segura, ver advertencias)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig();
const port = Number(process.env.PORT || cfg.port || 4317);
const args = new Set(process.argv.slice(2));
let token = process.env.AGENT_OFFICE_TOKEN || '';
try { token ||= fs.readFileSync(path.join(root, 'data', 'token.txt'), 'utf8').trim(); } catch { /* aún no hay token: arranca el servidor una vez */ }

const run = (cmd, a) => new Promise((resolve) => execFile(cmd, a, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => resolve({ err, out: String(stdout || ''), errOut: String(stderr || '') })));

async function qr(url) {
  try {
    const { default: QRCode } = await import('qrcode');
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  } catch { console.log('(no pude generar el QR; copia la dirección de arriba)'); }
}
const h = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function serverUp() {
  try { return (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'x-token': token } })).ok; } catch { return false; }
}

async function findTailscale() {
  for (const c of ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']) {
    const r = await run(c, ['version']);
    if (!r.err) return c;
  }
  return null;
}

async function tailscaleMode() {
  h('Opción recomendada: Tailscale (red privada cifrada, funciona desde cualquier lugar)');
  const ts = await findTailscale();
  if (!ts) {
    console.log(`
Tailscale no está instalado en este PC. Pasos:
  1. En este PC:   winget install --id Tailscale.Tailscale      (o descárgalo de tailscale.com/download)
  2. Abre Tailscale e inicia sesión (cuenta Google/Microsoft/GitHub).
  3. En el celular: instala la app "Tailscale" (App Store / Google Play) e inicia sesión con LA MISMA cuenta.
  4. En https://login.tailscale.com/admin/dns activa "MagicDNS" y "HTTPS Certificates" (una sola vez).
  5. Vuelve a correr:  npm run phone -- --setup
Ventaja: el servidor de la oficina sigue escuchando solo en este PC (127.0.0.1); no se abre ningún puerto en tu Wi-Fi.`);
    return false;
  }
  const st = await run(ts, ['status', '--json']);
  let s; try { s = JSON.parse(st.out); } catch { s = null; }
  if (!s || s.BackendState !== 'Running') {
    console.log(`Tailscale está instalado pero no conectado (estado: ${s?.BackendState || 'desconocido'}). Ábrelo e inicia sesión, luego repite este comando.`);
    return false;
  }
  const dns = String(s.Self?.DNSName || '').replace(/\.$/, '');
  if (!dns) { console.log('No pude leer el nombre de tu PC en Tailscale (¿MagicDNS desactivado?). Actívalo en el panel de administración.'); return false; }

  const serve = await run(ts, ['serve', 'status']);
  const active = new RegExp(`(127\\.0\\.0\\.1|localhost):${port}`).test(serve.out);
  if (!active) {
    if (!args.has('--setup')) {
      console.log(`Tailscale está conectado (${dns}), pero la oficina todavía no está publicada en tu red privada.\nEjecuta:  npm run phone -- --setup`);
      return false;
    }
    const r = await run(ts, ['serve', '--bg', String(port)]);
    if (r.err) { console.log('No pude activar "tailscale serve":', (r.errOut || r.err.message).trim(), '\n(puede pedir activar HTTPS en el panel de administración; sigue el enlace que muestre).'); return false; }
    console.log(`Publicada en tu red privada con: tailscale serve --bg ${port}   (se quita con: tailscale serve reset)`);
  }
  const url = `https://${dns}/?token=${token}`;
  h('Listo. Abre esto en el celular (con la app Tailscale conectada):');
  console.log(url);
  await qr(url);
  console.log('En el celular: ábrelo en Chrome/Safari → menú → "Instalar app" / "Añadir a pantalla de inicio".');
  return true;
}

async function lanMode() {
  h('Alternativa: misma red Wi-Fi (sin Tailscale)');
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal && !/^(169\.254|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)).map((i) => i.address);
  if (!ips.length) { console.log('No encontré una IP de red local.'); return; }
  const url = `http://${ips[0]}:${port}/?token=${token}`;
  console.log(`Advertencias: la conexión NO va cifrada (el token viaja en claro por tu Wi-Fi) y solo funciona en casa.
Para usarla:
  1. Cierra el servidor y arráncalo escuchando en la red:   $env:HOST="0.0.0.0"; npm start
  2. Permite el puerto SOLO para tu red local (PowerShell como administrador):
       New-NetFirewallRule -DisplayName "Oficina de Agentes" -Direction Inbound -Protocol TCP -LocalPort ${port} -RemoteAddress LocalSubnet -Action Allow
  3. Abre en el celular (mismo Wi-Fi):`);
  console.log('\n' + url);
  await qr(url);
  console.log('Nota: por ser http (no https) el navegador no permitirá "instalar" la app, solo abrirla o añadir un acceso directo.');
}

if (!token) console.log('Aún no existe data/token.txt: arranca el servidor una vez con `npm start`.');
else if (!(await serverUp())) console.log(`\x1b[33mAviso: el servidor no responde en 127.0.0.1:${port}. Arráncalo con \`npm start\`.\x1b[0m`);

if (args.has('--lan')) await lanMode();
else await tailscaleMode();
if (!args.has('--lan')) console.log('\n¿Sin Tailscale? Alternativa solo para tu Wi-Fi de casa:  npm run phone -- --lan');
