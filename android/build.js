// Construye la app Android (APK) sin Gradle, solo con las herramientas del SDK:
//   aapt2 (recursos) → javac → d8 (dex) → aapt (añade el dex) → zipalign → apksigner
//   node android/build.js            → android/build/oficina.apk
//   node android/build.js --install  → además la instala por USB/emulador con adb (-r: actualiza)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const app = path.join(here, 'app');
const out = path.join(here, 'build');
const PKG = 'local.oficina.agentes';
const VERSION = { code: 1, name: '0.1.0' };

// ---------- Herramientas ----------
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
const newest = (dir, rx) => fs.readdirSync(dir).filter((d) => rx.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
const btName = newest(path.join(sdk, 'build-tools'), /^\d+\.\d+\.\d+$/);
const platName = fs.existsSync(path.join(sdk, 'platforms', 'android-34')) ? 'android-34' : newest(path.join(sdk, 'platforms'), /^android-\d+$/);
if (!btName || !platName) { console.error(`No encuentro build-tools/platforms en ${sdk}. Instálalos desde Android Studio (SDK Manager).`); process.exit(1); }
const bt = path.join(sdk, 'build-tools', btName);
const androidJar = path.join(sdk, 'platforms', platName, 'android.jar');
const javaBin = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : '';
const tool = (name) => (javaBin ? path.join(javaBin, name) : name);
const exe = (n) => path.join(bt, n + (process.platform === 'win32' ? '.exe' : ''));

const run = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }); }
  catch (e) { console.error(`\n✗ Falló: ${path.basename(cmd)} ${args.slice(0, 3).join(' ')} …\n${e.stdout || ''}${e.stderr || e.message}`); process.exit(1); }
};
const step = (msg) => console.log(`• ${msg}`);
const walk = (dir, rx, acc = []) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); f.isDirectory() ? walk(p, rx, acc) : rx.test(f.name) && acc.push(p); } return acc; };

console.log(`Android SDK: build-tools ${btName}, ${platName}`);
fs.rmSync(out, { recursive: true, force: true });
for (const d of ['res', 'gen', 'classes', 'dex']) fs.mkdirSync(path.join(out, d), { recursive: true });

// ---------- Íconos (una sola fuente: web/icons) ----------
const resDir = path.join(out, 'res-all');
fs.cpSync(path.join(app, 'res'), resDir, { recursive: true });
const icons = path.join(root, 'web', 'icons');
for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
  const dir = path.join(resDir, `mipmap-${d}`); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(icons, 'icon-192.png'), path.join(dir, 'ic_launcher.png'));
  fs.copyFileSync(path.join(icons, 'icon-maskable-512.png'), path.join(dir, 'ic_launcher_fg.png'));
}

// ---------- 1. Recursos ----------
step('Compilando recursos');
run(exe('aapt2'), ['compile', '--dir', resDir, '-o', path.join(out, 'res.zip')]);
step('Enlazando manifiesto y recursos');
const baseApk = path.join(out, 'base.apk');
run(exe('aapt2'), ['link', '-o', baseApk, '-I', androidJar, '--manifest', path.join(app, 'AndroidManifest.xml'),
  '--min-sdk-version', '24', '--target-sdk-version', '34', '--version-code', String(VERSION.code), '--version-name', VERSION.name,
  '-A', path.join(app, 'assets'), '--java', path.join(out, 'gen'), path.join(out, 'res.zip')]);

// ---------- 2. Java → clases → dex ----------
step('Compilando Java');
const sources = [...walk(path.join(app, 'java'), /\.java$/), ...walk(path.join(out, 'gen'), /\.java$/)];
run(tool('javac'), ['-encoding', 'UTF-8', '--release', '8', '-Xlint:-options', '-cp', androidJar, '-d', path.join(out, 'classes'), ...sources]);
step('Generando classes.dex');
const classes = walk(path.join(out, 'classes'), /\.class$/);
run(tool('java'), ['-cp', path.join(bt, 'lib', 'd8.jar'), 'com.android.tools.r8.D8', '--lib', androidJar, '--min-api', '24', '--output', path.join(out, 'dex'), ...classes]);
step('Añadiendo classes.dex al paquete');
run(exe('aapt'), ['add', baseApk, 'classes.dex'], { cwd: path.join(out, 'dex') });

// ---------- 3. Alinear y firmar ----------
step('Alineando');
const aligned = path.join(out, 'aligned.apk');
run(exe('zipalign'), ['-f', '-p', '4', baseApk, aligned]);

const ksDir = path.join(here, 'keystore'); fs.mkdirSync(ksDir, { recursive: true });
const ks = path.join(ksDir, 'oficina.jks'), passFile = path.join(ksDir, 'pass.txt');
if (!fs.existsSync(ks)) {
  step('Creando la llave de firma (solo la primera vez; guárdala: la necesitas para actualizar la app)');
  const pass = crypto.randomBytes(12).toString('hex'); fs.writeFileSync(passFile, `${pass}\n`);
  run(tool('keytool'), ['-genkeypair', '-keystore', ks, '-alias', 'oficina', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-storepass', pass, '-keypass', pass, '-dname', 'CN=Oficina de Agentes']);
}
// apksigner lee una línea por contraseña (almacén y llave): el archivo lleva la misma clave dos veces.
const pw = fs.readFileSync(passFile, 'utf8').split('\n')[0].trim();
fs.writeFileSync(passFile, `${pw}\n${pw}\n`);
step('Firmando');
const apk = path.join(out, 'oficina.apk');
run(tool('java'), ['-jar', path.join(bt, 'lib', 'apksigner.jar'), 'sign', '--ks', ks, '--ks-pass', `file:${passFile}`, '--key-pass', `file:${passFile}`, '--out', apk, aligned]);
run(tool('java'), ['-jar', path.join(bt, 'lib', 'apksigner.jar'), 'verify', apk]);

for (const f of ['res.zip', 'base.apk', 'aligned.apk']) fs.rmSync(path.join(out, f), { force: true });
console.log(`\n✓ ${apk}  (${Math.round(fs.statSync(apk).size / 1024)} KB)`);

if (process.argv.includes('--install')) {
  const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  const devs = run(adb, ['devices']).split('\n').slice(1).filter((l) => /\tdevice$/.test(l.trim()));
  if (!devs.length) { console.log('No hay ningún teléfono/emulador conectado. Conecta el teléfono por USB con "Depuración USB" activada.'); process.exit(1); }
  step('Instalando en el dispositivo');
  console.log(run(adb, ['install', '-r', apk]).trim());
}
