// Arranque automático del servidor al iniciar sesión en Windows, sin ventana ni terminal.
//
//   npm run autostart:install             instala (solo este PC: 127.0.0.1)
//   npm run autostart:install -- --lan    igual, pero escuchando en tu red local (celular por Wi-Fi; sin cifrar)
//   npm run autostart:install -- --start  además lo arranca ahora mismo
//   npm run autostart:status | autostart:stop | autostart:start | autostart:remove
//
// Cómo funciona: compila en tu PC un pequeño lanzador llamado "Oficina de Agentes.exe" (código en
// scripts/launcher/OficinaLauncher.cs; usa el compilador de .NET que ya trae Windows) y crea un acceso directo en la
// carpeta Inicio de tu usuario (no necesita administrador). El lanzador se ve en el Administrador de tareas
// (pestañas Procesos/Detalles y "Aplicaciones de inicio"), ejecuta el servidor oculto y lo reinicia si se cae.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const action = args.find((a) => !a.startsWith('--') && !(args[args.indexOf(a) - 1] || '').startsWith('--d')) || 'status';
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : null); // --dir / --data: solo para pruebas
const NAME = 'Oficina de Agentes';

if (process.platform !== 'win32') {
  console.error('El arranque automático solo está implementado para Windows.\nEn macOS/Linux usa launchd o systemd apuntando a: node server/index.js');
  process.exit(1);
}

const startupDir = opt('dir') || path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const dataDir = opt('data') || path.join(root, 'data');
const exe = path.join(dataDir, `${NAME}.exe`);
const lnk = path.join(startupDir, `${NAME}.lnk`);
const srcOut = path.join(dataDir, 'OficinaLauncher.generated.cs');
const oldVbs = path.join(startupDir, 'Oficina-de-Agentes.vbs'); // versión anterior del arranque automático

const ps = (cmd) => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return ''; } };
const q = (s) => s.replace(/'/g, "''");
const port = Number(process.env.PORT || loadConfig().port || 4317);

function launcherPids() {
  const out = ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${q(exe)}' } | ForEach-Object { $_.ProcessId }`);
  return out ? out.split(/\r?\n/).map(Number).filter(Boolean) : [];
}
function stopLauncher() {
  // Al terminar el lanzador, Windows cierra también el servidor (Job Object).
  for (const pid of launcherPids()) { try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* ya terminó */ } }
  const vbs = ps(`Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | Where-Object { $_.CommandLine -like '*Oficina-de-Agentes.vbs*' } | ForEach-Object { $_.ProcessId }`);
  for (const pid of vbs ? vbs.split(/\r?\n/) : []) { try { execFileSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore' }); } catch { /* ya terminó */ } }
}

// Un .ico que contiene el PNG de la app (Windows admite PNG dentro de .ico)
function makeIco() {
  const png = fs.readFileSync(path.join(root, 'web', 'icons', 'icon-192.png'));
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);       // tipo icono, 1 imagen
  head[6] = 192; head[7] = 192;                             // ancho, alto
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);    // planos, bits por píxel
  head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

function compile(lan) {
  const csc = ['Framework64', 'Framework'].map((f) => path.join(process.env.WINDIR, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(fs.existsSync);
  if (!csc) { console.error('No encuentro el compilador de .NET (csc.exe) en tu Windows. Instala ".NET Framework 4.x" desde Características de Windows.'); process.exit(1); }
  const tpl = fs.readFileSync(path.join(root, 'scripts', 'launcher', 'OficinaLauncher.cs'), 'utf8');
  fs.writeFileSync(srcOut, tpl.replace('@@ROOT@@', () => root).replace('@@NODE@@', () => process.execPath).replace('@@LAN@@', lan ? 'true' : 'false'));
  const ico = path.join(dataDir, 'oficina.ico'); fs.writeFileSync(ico, makeIco());
  const base = ['/nologo', '/target:winexe', '/optimize+', `/out:${exe}`];
  try { execFileSync(csc, [...base, `/win32icon:${ico}`, srcOut], { stdio: 'pipe', encoding: 'utf8' }); }
  catch (e) {
    if (!/icon|ico/i.test(String(e.stdout) + String(e.stderr))) { console.error('Falló la compilación del lanzador:\n' + (e.stdout || e.stderr || e.message)); process.exit(1); }
    try { execFileSync(csc, [...base, srcOut], { stdio: 'pipe', encoding: 'utf8' }); console.log('  (se compiló sin ícono)'); }
    catch (e2) { console.error('Falló la compilación del lanzador:\n' + (e2.stdout || e2.stderr || e2.message)); process.exit(1); }
  }
}

const startNow = () => spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true, cwd: root }).unref();
const isLan = () => fs.existsSync(srcOut) && /const bool Lan = true;/.test(fs.readFileSync(srcOut, 'utf8'));
const listening = () => ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty LocalAddress)`);

if (action === 'install') {
  fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(startupDir, { recursive: true });
  stopLauncher();
  if (fs.existsSync(oldVbs)) fs.rmSync(oldVbs);
  compile(flag('lan'));
  ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${q(lnk)}'); $s.TargetPath='${q(exe)}'; $s.WorkingDirectory='${q(root)}'; $s.Description='Servidor de la Oficina de Agentes'; $s.Save()`);
  console.log(`✓ Arranque automático instalado (${flag('lan') ? 'modo RED LOCAL: el celular puede entrar por tu Wi-Fi, sin cifrar' : 'modo LOCAL: solo este PC; para el celular usa Tailscale'}).`);
  console.log(`  Programa:  ${exe}\n  Inicio:    ${lnk}\n  Registro:  ${path.join(root, 'data', 'server.log')}`);
  if (flag('start')) { startNow(); console.log('  Servidor arrancando ahora (oculto)…'); }
  else console.log('  Se activará la próxima vez que inicies sesión (o usa: npm run autostart:start).');
  console.log('  Lo verás en el Administrador de tareas como "Oficina de Agentes".');
} else if (action === 'start') {
  if (!fs.existsSync(exe)) { console.error('No está instalado. Ejecuta: npm run autostart:install'); process.exit(1); }
  if (launcherPids().length) console.log('Ya está en marcha.'); else { startNow(); console.log('Arrancando (oculto)…'); }
} else if (action === 'stop') {
  const n = launcherPids().length; stopLauncher();
  console.log(n ? '✓ Detenido. Vuelve a arrancar solo en tu próximo inicio de sesión (o con: npm run autostart:start).' : 'No estaba en marcha.');
} else if (action === 'remove') {
  stopLauncher();
  for (const f of [lnk, exe, srcOut, path.join(dataDir, 'oficina.ico'), oldVbs]) if (fs.existsSync(f)) fs.rmSync(f);
  console.log('✓ Arranque automático quitado y servidor detenido.');
} else {
  const installed = fs.existsSync(lnk) && fs.existsSync(exe);
  const pids = launcherPids(), addr = listening();
  console.log(`Arranque automático: ${installed ? `instalado (${isLan() ? 'red local' : 'solo este PC'})` : 'no instalado'}`);
  console.log(`"${NAME}" en marcha: ${pids.length ? `sí (pid ${pids.join(', ')})` : 'no'}`);
  console.log(`Servidor en el puerto ${port}: ${addr ? `sí (escuchando en ${addr})` : 'no'}`);
}
