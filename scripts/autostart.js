// Arranque automático del servidor al iniciar sesión en Windows, sin ventana ni terminal.
//   npm run autostart:install            → se inicia solo en cada inicio de sesión (solo tu PC: 127.0.0.1)
//   npm run autostart:install -- --lan   → igual, pero escuchando en tu red local (para el celular por Wi-Fi; sin cifrar)
//   npm run autostart:install -- --start → además lo arranca ahora mismo
//   npm run autostart:status | autostart:remove
//
// Cómo funciona: deja un pequeño .vbs en la carpeta "Inicio" de tu usuario (no necesita permisos de administrador).
// Ese script ejecuta el servidor oculto y lo vuelve a levantar si se cae. El registro va a data/server.log.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const action = args.find((a) => !a.startsWith('--')) || 'status';
const flag = (n) => args.includes(`--${n}`);
const dirArg = args.indexOf('--dir') >= 0 ? args[args.indexOf('--dir') + 1] : null; // solo para pruebas
const NAME = 'Oficina-de-Agentes.vbs';

if (process.platform !== 'win32') {
  console.error('El arranque automático solo está implementado para Windows.\nEn macOS/Linux usa launchd o systemd apuntando a: node server/index.js');
  process.exit(1);
}

const startupDir = dirArg || path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const file = path.join(startupDir, NAME);
const ps = (cmd) => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return ''; } };

function supervisorPids() {
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | Where-Object { $_.CommandLine -like '*${NAME}*' } | ForEach-Object { $_.ProcessId }`);
  return out ? out.split(/\r?\n/).map(Number).filter(Boolean) : [];
}
function stopSupervisor() {
  for (const pid of supervisorPids()) { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* ya terminó */ } }
}

function buildVbs(lan) {
  const node = process.execPath;
  const inner = `${lan ? 'set "HOST=0.0.0.0" && ' : ''}"${node}" --disable-warning=ExperimentalWarning server\\index.js >> "data\\server.log" 2>&1`;
  const literal = `"cmd /c ""${inner.replace(/"/g, '""')}"""`; // literal de VBScript: las comillas se duplican
  return [
    `' Oficina de Agentes: arranque automático (generado por "npm run autostart:install").`,
    `' Para quitarlo: npm run autostart:remove   (o borra este archivo y cierra wscript.exe desde el Administrador de tareas)`,
    `Set sh = CreateObject("WScript.Shell")`,
    `sh.CurrentDirectory = "${root}"`,
    `Do`,
    `  sh.Run ${literal}, 0, True`,
    `  WScript.Sleep 5000`,
    `Loop`,
    '',
  ].join('\r\n');
}

const port = Number(process.env.PORT || loadConfig().port || 4317);
const listening = () => ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty LocalAddress)`);

if (action === 'install') {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(startupDir, { recursive: true });
  stopSupervisor();
  fs.writeFileSync(file, buildVbs(flag('lan')));
  console.log(`✓ Arranque automático instalado (${flag('lan') ? 'modo RED LOCAL: el celular puede entrar por tu Wi-Fi, sin cifrar' : 'modo LOCAL: solo este PC; para el celular usa Tailscale'}).`);
  console.log(`  Archivo: ${file}\n  Registro: ${path.join(root, 'data', 'server.log')}`);
  if (flag('start')) {
    spawn('wscript.exe', ['//B', '//Nologo', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    console.log('  Servidor arrancando ahora (oculto)…');
  } else {
    console.log('  Se activará la próxima vez que inicies sesión en Windows (o corre de nuevo con --start para arrancarlo ya).');
  }
} else if (action === 'remove') {
  stopSupervisor();
  if (fs.existsSync(file)) fs.rmSync(file);
  console.log('✓ Arranque automático quitado y servidor supervisado detenido.');
} else {
  const installed = fs.existsSync(file);
  const lan = installed && /HOST=0\.0\.0\.0/.test(fs.readFileSync(file, 'utf8'));
  const pids = supervisorPids();
  const addr = listening();
  console.log(`Arranque automático: ${installed ? `instalado (${lan ? 'red local' : 'solo este PC'})` : 'no instalado'}`);
  console.log(`Supervisor en marcha: ${pids.length ? 'sí' : 'no'}`);
  console.log(`Servidor en el puerto ${port}: ${addr ? `sí (escuchando en ${addr})` : 'no'}`);
}
