// Oficina pixel-art animada (canvas procedural, sin imágenes).
// Los agentes son personajes que caminan: trabajan sentados, se levantan a pedir ayuda, van al dispensador,
// se sientan en el sofá o pasean. Las coordenadas de cada sala son locales (256x150) y se trasladan con OX/OY.

// ---------- Fuente pixel 3x5 ----------
const GLYPHS = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001110', '.': '000000000000010', '-': '000000111000000', ':': '000010000010000', '/': '001001010100100',
  _: '000000000000111', '!': '010010010000010', '?': '110001010000010', '(': '001010010010001', ')': '100010010010100',
  ',': '000000000010100', '+': '000010111010000', '$': '011110010011110', '>': '100010001010100', "'": '010010000000000',
  '%': '101001010100101', '#': '101111101111101', ' ': '000000000000000',
};
const clean = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const textW = (s) => Math.max(0, s.length * 4 - 1);

// ---------- Geometría ----------
export const RW = 256, RH = 168;
const WALL = 34;
const LANE_A = 88, LANE_B = 140;            // pasillos (y de los pies)
const GUT_L = 20, GUT_R = 232;              // pasillos verticales que los conectan
const COOLER_X = 27, SOFA_X = 200, SOFA_Y = 154;
const SPEED = 26;                            // px/s
const MAX_SEATS = 6;

const seatOf = (i) => {
  if (i >= MAX_SEATS) return null;
  const col = i % 3, row = Math.floor(i / 3), sx = 28 + col * 78, sy = 50 + row * 52;
  return { sx, sy, row, x: sx + 20, y: sy + 17, lane: row ? LANE_B : LANE_A };
};
const laneY = (l) => (l === 'A' ? LANE_A : LANE_B);

// ---------- Utilidades ----------
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const hash = (s) => [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0);
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
const SKINS = ['#f0c9a0', '#e0ac82', '#c68a5e', '#8d5a3b', '#f7d9b8'];
const HAIRS = ['#3b2a20', '#1f1f2e', '#7a4a2a', '#c9a24a', '#2a3b5a', '#6b2f2f', '#e8e0d0'];
const ACC = { claude: 'band', gemini: 'star', copilot: 'goggles' };

export function createOffice(cv, api) {
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  let OX = 0, OY = 0, W = RW * 2, H = RH * 2;

  const R = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x) + OX, Math.round(y) + OY, w, h); };
  const P = (x, y, c) => R(x, y, 1, 1, c);
  function text(str, x, y, c, shadow) {
    const s = clean(str);
    if (shadow) text(str, x + 1, y + 1, shadow);
    ctx.fillStyle = c;
    let cx = Math.round(x);
    for (const ch of s) {
      const g = GLYPHS[ch] || GLYPHS['?'];
      for (let i = 0; i < 15; i++) if (g[i] === '1') ctx.fillRect(cx + (i % 3) + OX, Math.round(y) + Math.floor(i / 3) + OY, 1, 1);
      cx += 4;
    }
  }
  function line(x0, y0, x1, y1, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      P(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  // ---------- Simulación ----------
  const anims = new Map();   // id → estado de animación del agente
  const parts = new Map();   // sala → partículas
  let last = performance.now();

  const emit = (room, x, y, o = {}) => {
    if (!parts.has(room)) parts.set(room, []);
    parts.get(room).push({ x, y, vx: o.vx || 0, vy: o.vy || 0, g: o.g || 0, life: o.life || 1, max: o.life || 1, c: o.c || '#fff', s: o.s || 1 });
  };
  const poof = (room, x, y) => { for (let i = 0; i < 10; i++) { const a = (i / 10) * 6.28; emit(room, x, y - 6, { vx: Math.cos(a) * 22, vy: Math.sin(a) * 22, life: 0.5, c: i % 2 ? '#fff' : '#cfd8ff', s: 2 }); } };
  const confetti = (room, x, y) => { for (let i = 0; i < 18; i++) emit(room, x, y - 18, { vx: rnd(-30, 30), vy: rnd(-55, -20), g: 90, life: rnd(0.9, 1.4), c: pick(['#ff5d8f', '#ffd166', '#5fd18b', '#4f8cff', '#a06cf0', '#fff']), s: 2 }); };

  function route(an, tx, ty, tLane) {
    const pts = [];
    let { x, y } = an;
    let lane = Math.abs(y - LANE_A) < 1 ? 'A' : Math.abs(y - LANE_B) < 1 ? 'B' : null;
    if (!lane) { const ly = Math.abs(y - LANE_A) < Math.abs(y - LANE_B) ? LANE_A : LANE_B; pts.push({ x, y: ly }); y = ly; lane = ly === LANE_A ? 'A' : 'B'; }
    if (lane !== tLane) {
      const g = Math.abs(x - GUT_L) < Math.abs(x - GUT_R) ? GUT_L : GUT_R;
      pts.push({ x: g, y: laneY(lane) }, { x: g, y: laneY(tLane) }); x = g; lane = tLane;
    }
    pts.push({ x: tx, y: laneY(lane) });
    if (ty !== laneY(lane)) pts.push({ x: tx, y: ty });
    return pts;
  }

  function pickIdle(an, a) {
    const long = api.statusMs(a) > 150000;
    const r = Math.random();
    const kind = long ? 'sofa' : r < 0.28 ? 'cooler' : r < 0.52 ? 'sofa' : r < 0.76 ? 'strollA' : 'strollB';
    an.dest = kind;
    if (kind === 'cooler') an.path = route(an, COOLER_X, LANE_B, 'B');
    else if (kind === 'sofa') an.path = route(an, SOFA_X + rnd(-16, 16), SOFA_Y, 'B');
    else { const l = kind === 'strollA' ? 'A' : 'B'; an.path = route(an, rnd(GUT_L + 6, GUT_R - 6), laneY(l), l); }
  }

  function setGoal(an, goal, seat, a) {
    an.goal = goal; an.seatKey = seat ? `${seat.sx},${seat.sy}` : '';
    if (goal === 'seat') { an.dest = 'seat'; an.path = route(an, seat.x, seat.y, seat.lane); }
    else if (goal === 'wave') { an.dest = 'wave'; an.path = route(an, seat.x, laneY(seat.lane), seat.lane); }
    else pickIdle(an, a);
    an.mode = 'walking';
  }

  function arrive(an) {
    if (an.dest === 'seat') an.mode = 'seated';
    else if (an.dest === 'wave') { an.mode = 'waving'; an.dir = 0; }
    else if (an.dest === 'cooler') { an.mode = 'standing'; an.dir = -1; an.pause = rnd(4, 8); }
    else if (an.dest === 'sofa') { an.mode = 'sitting'; an.dir = 0; an.pause = rnd(8, 20); }
    else { an.mode = 'standing'; an.dir = 0; an.pause = rnd(1.5, 4); }
  }

  // Los agentes que ya estaban al abrir la página aparecen directamente en su sitio; los nuevos entran por la derecha.
  const born = performance.now();
  function newAnim(id, room) {
    const snap = performance.now() - born < 3000;
    const an = { id, room, x: RW - 28, y: LANE_B, dir: -1, mode: 'walking', path: [], goal: null, seatKey: '', dest: '', pause: 0, prev: null, doneUntil: 0, fx: 0, snap };
    if (!snap) poof(room, an.x, an.y);
    return an;
  }

  function stepAnim(an, a, seat, dt, now) {
    const st = a.status;
    const goal = seat && (st === 'working' || st === 'exhausted') ? 'seat' : seat && st === 'waiting' ? 'wave' : 'idle';
    if (goal !== an.goal || (seat && an.seatKey !== `${seat.sx},${seat.sy}`)) {
      setGoal(an, goal, seat, a);
      if (an.snap && an.path.length) { const e = an.path[an.path.length - 1]; an.x = e.x; an.y = e.y; an.path = []; arrive(an); }
      an.snap = false;
    }

    if (an.prev && an.prev !== st) {
      if (an.prev === 'working' && st === 'idle') { confetti(an.room, an.x, an.y); an.doneUntil = now + 3200; }
      if (st === 'exhausted') poof(an.room, an.x, an.y);
    }
    an.prev = st;

    if (an.path.length) {
      const p = an.path[0], dx = p.x - an.x, dy = p.y - an.y, dist = Math.hypot(dx, dy), s = SPEED * dt;
      if (Math.abs(dx) > 0.5) an.dir = dx > 0 ? 1 : -1;
      if (dist <= s) { an.x = p.x; an.y = p.y; an.path.shift(); } else { an.x += (dx / dist) * s; an.y += (dy / dist) * s; }
      an.mode = 'walking';
      if (!an.path.length) arrive(an);
    } else if (an.goal === 'idle') {
      an.pause -= dt;
      if (an.pause <= 0) { pickIdle(an, a); an.mode = 'walking'; }
    }

    // efectos continuos
    an.fx -= dt;
    if (an.fx <= 0) {
      if (an.mode === 'seated' && st === 'working' && seat) { emit(an.room, seat.sx + rnd(14, 26), seat.sy + 5, { vy: -14, vx: rnd(-4, 4), life: 0.5, c: a.color }); an.fx = 0.16; }
      else if (an.mode === 'seated' && st === 'exhausted' && seat) { emit(an.room, seat.x + 5, seat.sy + 4, { vy: 8, g: 40, life: 0.9, c: '#7fd6ff', s: 2 }); an.fx = 0.7; }
      else an.fx = 0.2;
    }
  }

  function updateSim(dt, now) {
    const depts = api.model().config.departments;
    const seen = new Set();
    for (const d of depts) {
      api.model().agents.filter((a) => a.dept === d.id).forEach((a, i) => {
        seen.add(a.id);
        let an = anims.get(a.id);
        if (!an) { an = newAnim(a.id, d.id); anims.set(a.id, an); }
        if (an.room !== d.id) { poof(an.room, an.x, an.y); an.room = d.id; an.x = RW - 28; an.y = LANE_B; an.path = []; an.goal = null; poof(d.id, an.x, an.y); }
        an.slot = i;
        stepAnim(an, a, seatOf(i), dt, now);
      });
    }
    for (const [id, an] of anims) if (!seen.has(id)) { poof(an.room, an.x, an.y); anims.delete(id); }
    // vapor del dispensador
    for (const d of depts) if (Math.random() < dt * 2.5) emit(d.id, 10 + rnd(-1, 1), 104, { vy: -9, life: 1.1, c: '#e8f4ff' });
    for (const list of parts.values()) {
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        p.life -= dt; if (p.life <= 0) { list.splice(i, 1); continue; }
        p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      }
    }
  }

  // ---------- Dibujo ----------
  function skyColors() {
    const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
    if (h >= 7 && h < 17.5) return { top: '#5fb3ff', bot: '#b8e2ff', night: false };
    if (h >= 17.5 && h < 19.5) return { top: '#ff8a5c', bot: '#ffd08a', night: false };
    return { top: '#0e1440', bot: '#232a6b', night: true };
  }

  function drawWindow(x, y, sky, t, k) {
    R(x, y, 22, 20, '#eef0fa'); R(x + 1, y + 1, 20, 18, sky.top); R(x + 1, y + 10, 20, 9, sky.bot);
    if (sky.night) {
      for (let i = 0; i < 4; i++) if ((Math.floor(t / 500) + i + k) % 3) P(x + 3 + ((i * 5 + k * 3) % 16), y + 3 + ((i * 3) % 7), '#fff');
      R(x + 15, y + 3, 3, 3, '#fff8cf'); P(x + 16, y + 3, sky.top);
    } else {
      R(x + 15, y + 3, 3, 3, '#fff3a0');
      const cx = x + 2 + Math.round((Math.sin(t / 4000 + k * 2) + 1) * 5);
      R(cx, y + 6, 7, 2, '#fff'); R(cx + 1, y + 5, 4, 1, '#fff');
    }
    R(x + 10, y + 1, 2, 18, '#eef0fa'); R(x + 1, y + 10, 20, 1, '#eef0fa');
  }

  function drawClock(x, y) {
    R(x + 2, y, 9, 13, '#141728'); R(x, y + 2, 13, 9, '#141728'); R(x + 1, y + 1, 11, 11, '#141728');
    R(x + 2, y + 1, 9, 11, '#f7f4ec'); R(x + 1, y + 2, 11, 9, '#f7f4ec');
    const d = new Date(), cx = x + 6, cy = y + 6;
    const m = (d.getMinutes() + d.getSeconds() / 60) / 60 * 6.283, h = ((d.getHours() % 12) + d.getMinutes() / 60) / 12 * 6.283;
    line(cx, cy, cx + Math.sin(h) * 3, cy - Math.cos(h) * 3, '#141728');
    line(cx, cy, cx + Math.sin(m) * 4.5, cy - Math.cos(m) * 4.5, '#c94b4b');
  }

  const PROPS = {
    backend(x, y, t) {
      R(x, y, 28, 28, '#0d1020'); R(x, y, 28, 1, '#39406e');
      for (let i = 0; i < 3; i++) {
        R(x + 2, y + 2 + i * 9, 24, 7, '#1c2242');
        for (let j = 0; j < 4; j++) {
          const on = (Math.floor(t / 280) + i * 3 + j * 7) % 5 !== 0;
          R(x + 4 + j * 5, y + 4 + i * 9, 2, 2, on ? (j % 2 ? '#5fe08a' : '#7fd6ff') : '#2a3060');
        }
        R(x + 20, y + 4 + i * 9, 4, 1, '#39406e'); R(x + 20, y + 6 + i * 9, 4, 1, '#39406e');
      }
    },
    frontend(x, y, t) {
      R(x, y, 34, 28, '#141728'); R(x + 1, y + 1, 32, 26, '#f7f4ec');
      const cols = ['#ff5d8f', '#ffb400', '#5fd18b', '#4f8cff', '#a06cf0', '#ff7a45'];
      cols.forEach((c, i) => R(x + 4 + (i % 3) * 10, y + 4 + Math.floor(i / 3) * 10, 8, 8, c));
      const k = Math.floor(t / 900) % 6, px = x + 4 + (k % 3) * 10 + 5, py = y + 4 + Math.floor(k / 3) * 10 + 5;
      R(px, py, 3, 1, '#141728'); R(px, py, 1, 3, '#141728'); R(px + 1, py + 1, 2, 2, '#fff');
      R(x + 4, y + 23, 24, 2, '#e0d9c8');
    },
    marketing(x, y, t) {
      R(x, y, 34, 28, '#141728'); R(x + 1, y + 1, 32, 26, '#f7f4ec');
      for (let i = 0; i < 5; i++) {
        const h = Math.max(3, Math.min(20, Math.round(5 + i * 3 + (Math.sin(t / 700 + i) + 1) * 2.5)));
        R(x + 4 + i * 6, y + 24 - h, 4, h, i === 4 ? '#5fd18b' : '#ffb400');
      }
      line(x + 4, y + 20, x + 28, y + 5, '#c94b4b'); R(x + 27, y + 4, 3, 2, '#c94b4b');
    },
    qa(x, y, t) {
      R(x, y, 34, 28, '#141728'); R(x + 1, y + 1, 32, 26, '#f7f4ec');
      for (let i = 0; i < 4; i++) {
        R(x + 4, y + 4 + i * 6, 4, 4, '#141728'); R(x + 5, y + 5 + i * 6, 2, 2, '#f7f4ec');
        R(x + 11, y + 6 + i * 6, 18, 1, '#b9b3a3');
        if ((Math.floor(t / 1100) + i) % 5 < 4) { P(x + 5, y + 6 + i * 6, '#2fa866'); P(x + 6, y + 7 + i * 6, '#2fa866'); P(x + 7, y + 4 + i * 6, '#2fa866'); }
      }
    },
  };

  function drawRoomBase(d, list, t, sky) {
    const c = d.color;
    const wall = shade(c, -0.55), wallHi = shade(c, -0.42), trim = shade(c, -0.72);
    const fA = shade(c, -0.32), fB = shade(c, -0.4);
    // pared
    R(0, 0, RW, WALL, wall);
    for (let x = 0; x < RW; x += 32) R(x, 0, 1, WALL - 2, wallHi);
    R(0, 24, RW, 8, wallHi); R(0, 24, RW, 1, shade(c, -0.3));
    R(0, WALL - 2, RW, 2, trim);
    // suelo
    for (let y = 0; y < Math.ceil((RH - WALL) / 8); y++) for (let x = 0; x < RW / 8; x++) R(x * 8, WALL + y * 8, 8, 8, (x + y) % 2 ? fA : fB);
    R(0, WALL, RW, 1, shade(c, -0.6));
    // cartel
    const nm = d.name.toUpperCase(), w = textW(nm) + 10;
    R(8, 5, w, 13, '#141728'); R(9, 6, w - 2, 11, c); R(9, 6, w - 2, 1, shade(c, 0.35)); text(nm, 13, 9, '#141728');
    // decoración de pared
    (PROPS[d.id] || PROPS.qa)(74, 4, t);
    drawWindow(118, 5, sky, t, 0); drawWindow(146, 5, sky, t, 1);
    drawClock(176, 8);
    // contadores
    const working = list.filter((a) => a.status === 'working').length;
    R(196, 4, 56, 21, '#141728'); R(197, 5, 54, 19, '#f7f4ec');
    text(`ACTIVOS ${working}`, 201, 8, '#2b3050'); text(`TOTAL ${list.length}`, 201, 16, '#7a7f99');
    if (working) R(244, 8, 3, 3, Math.floor(t / 400) % 2 ? '#2fa866' : '#a5e8c3');
  }

  function drawRug(seat, a, pal) {
    R(seat.sx - 5, seat.sy + 2, 50, 30, pal.rugEdge); R(seat.sx - 4, seat.sy + 3, 48, 28, pal.rug);
    if (a && a.status === 'working') { ctx.globalAlpha = 0.14; R(seat.sx + 8, seat.sy + 18, 24, 9, '#7dffb0'); ctx.globalAlpha = 1; }
  }

  function drawDesk(seat, a, an, t) {
    const { sx, sy } = seat;
    R(sx, sy, 40, 12, '#b07a4f'); R(sx, sy, 40, 2, '#d3a070'); R(sx, sy + 12, 40, 3, '#7a4f31');
    R(sx + 2, sy + 15, 3, 4, '#7a4f31'); R(sx + 35, sy + 15, 3, 4, '#7a4f31');
    // monitor
    R(sx + 12, sy - 11, 16, 11, '#161827');
    let scr = '#0c0d16';
    if (a) scr = a.status === 'working' ? '#0f2b1e' : a.status === 'waiting' ? (Math.floor(t / 350) % 2 ? '#f2b84b' : '#5a4514') : a.status === 'exhausted' ? '#5a1d1d' : '#25305a';
    R(sx + 13, sy - 10, 14, 8, scr); R(sx + 18, sy + 1, 4, 2, '#161827');
    if (a && a.status === 'working') for (let i = 0; i < 4; i++) R(sx + 14, sy - 9 + i * 2, 3 + ((Math.floor(t / 220) + i * 5) % 9), 1, '#5fe08a');
    else if (a && a.status === 'idle' && Math.floor(t / 500) % 2) R(sx + 14, sy - 9, 2, 1, '#6a74d8');
    else if (a && a.status === 'exhausted') { R(sx + 14, sy - 7, 12, 1, '#f26d6d'); R(sx + 16, sy - 5, 8, 1, '#f26d6d'); }
    else if (!a) P(sx + 26, sy - 3, Math.floor(t / 900) % 2 ? '#3b4166' : '#161827');
    R(sx + 13, sy + 6, 14, 3, '#e6e9f5');
    // detalles: taza y nota del dueño
    R(sx + 33, sy + 4, 3, 3, '#fff'); P(sx + 36, sy + 5, '#fff');
    if (a) { R(sx + 27, sy - 11, 3, 3, a.color); if (a.status === 'working') P(sx + 34, sy + 2 - (Math.floor(t / 400) % 2), 'rgba(255,255,255,.7)'); }
  }

  function look(a) {
    return { skin: SKINS[hash(a.id) % SKINS.length], hair: HAIRS[hash(a.agent + a.id) % HAIRS.length], acc: ACC[a.agent] || '' };
  }
  const tone = (a) => (a.status === 'exhausted' ? '#7a7f99' : a.color);

  function accessoriesFront(fx, top, L, a, t) {
    if (L.acc === 'band') R(fx - 3, top + 2, 6, 1, shade(a.color, 0.55));
    else if (L.acc === 'goggles') { R(fx - 3, top + 1, 6, 2, '#20233a'); R(fx - 3, top + 1, 2, 2, '#7fd6ff'); R(fx + 1, top + 1, 2, 2, '#7fd6ff'); }
    else if (L.acc === 'star') { const c = Math.floor(t / 500) % 2 ? '#ffe27a' : '#fff'; P(fx + 3, top - 2, c); R(fx + 2, top - 1, 3, 1, c); P(fx + 3, top, c); }
  }

  function drawPerson(fx, fy, a, an, t, o) {
    const L = look(a), col = tone(a);
    const bob = !o.walk && !o.sit && !o.wave && a.status === 'idle' ? Math.floor(t / 600) % 2 : 0;
    const y = fy - bob, top = y - 17 + (o.sit ? 4 : 0);
    if (!o.sit) R(fx - 4, fy, 8, 1, 'rgba(0,0,0,.25)');
    const f = o.walk ? Math.floor(t / 130) % 2 : 0;
    if (o.sit) { R(fx - 4, y - 3, 8, 3, '#2a2f52'); R(fx - 4, y - 1, 3, 1, '#14162a'); R(fx + 1, y - 1, 3, 1, '#14162a'); }
    else { R(fx - 3, y - 4 + f, 3, 4 - f, '#2a2f52'); R(fx, y - 4 + (1 - f), 3, 4 - (1 - f), '#2a2f52'); R(fx - 3, y - 1, 3, 1, '#14162a'); R(fx, y - 1, 3, 1, '#14162a'); }
    R(fx - 4, top + 6, 8, 7, col); R(fx - 4, top + 6, 8, 1, shade(col.startsWith('#') ? col : '#7a7f99', 0.25));
    const sw = o.walk ? (f ? 1 : -1) : 0;
    R(fx - 5, top + 7 + (sw > 0 ? 1 : 0), 1, 5, col);
    if (o.wave) { const w = Math.floor(t / 170) % 2; R(fx + 4, top + 1 + w, 2, 6, col); R(fx + 4, top - 1 + w, 2, 2, L.skin); }
    else R(fx + 4, top + 7 + (sw < 0 ? 1 : 0), 1, 5, col);
    R(fx - 3, top, 6, 6, L.skin); R(fx - 3, top, 6, 2, L.hair); R(fx - 3, top + 2, 1, 1, L.hair);
    const s = an.dir > 0 ? 1 : an.dir < 0 ? -1 : 0;
    if (!(L.acc === 'goggles')) { P(fx - 2 + s, top + 3, '#161827'); P(fx + 1 + s, top + 3, '#161827'); }
    if (a.status === 'waiting') R(fx - 1, top + 5, 2, 1, '#c94b4b');
    accessoriesFront(fx, top, L, a, t);
    return top;
  }

  function drawSeated(seat, a, t) {
    const L = look(a), col = tone(a), { sx, sy } = seat, cx = sx + 16, sl = a.status === 'exhausted' ? 2 : 0;
    R(cx - 1, sy + 8 + sl, 10, 9, '#2a2d45'); R(cx - 1, sy + 8 + sl, 10, 1, '#3b4066');
    R(cx + 1, sy + 3 + sl, 6, 6, L.hair);
    if (L.acc === 'band') R(cx + 1, sy + 5 + sl, 6, 1, shade(a.color, 0.55));
    else if (L.acc === 'goggles') R(cx + 1, sy + 5 + sl, 6, 1, '#20233a');
    else if (L.acc === 'star') { const c = Math.floor(t / 500) % 2 ? '#ffe27a' : '#fff'; R(cx + 6, sy + 2 + sl, 3, 1, c); P(cx + 7, sy + 1 + sl, c); P(cx + 7, sy + 3 + sl, c); }
    R(cx, sy + 9 + sl, 8, 7, col);
    const off = a.status === 'working' ? Math.floor(t / 150) % 2 : 0;
    R(cx - 2, sy + 11 + sl + off, 2, 4, col); R(cx + 8, sy + 11 + sl + (1 - off), 2, 4, col);
  }

  function drawSofa(t) {
    const c = '#8a4fd8';
    R(160, 144, 76, 5, shade(c, -0.2)); R(160, 149, 76, 5, c); R(160, 149, 76, 1, shade(c, 0.3));
    R(156, 145, 6, 12, shade(c, -0.35)); R(234, 145, 6, 12, shade(c, -0.35));
    R(160, 154, 76, 3, shade(c, -0.5));
    R(176, 149, 1, 5, shade(c, -0.15)); R(198, 149, 1, 5, shade(c, -0.15)); R(220, 149, 1, 5, shade(c, -0.15));
  }
  function drawCooler() {
    R(4, 114, 12, 26, '#dfe8f8'); R(4, 114, 12, 2, '#fff'); R(5, 102, 10, 12, '#7fd6ff'); R(5, 102, 10, 2, '#b8ecff');
    R(6, 120, 3, 2, '#c94b4b'); R(11, 120, 3, 2, '#4f8cff'); R(6, 134, 8, 6, '#b8c6e0');
  }
  function drawPlant(x, y, t) {
    const sw = Math.round(Math.sin(t / 900 + x) * 1);
    R(x, y + 14, 12, 9, '#a5623a'); R(x, y + 14, 12, 2, '#c98455');
    R(x + 1 + sw, y + 4, 10, 11, '#2fa866'); R(x + 3 + sw, y, 6, 6, '#56c273'); R(x - 1, y + 8, 3, 4, '#3fbf74'); R(x + 10, y + 7, 3, 4, '#3fbf74');
  }

  function drawBubble(cx, y, str, fg, bg, minX, maxX) {
    const s = clean(str), w = textW(s) + 6;
    const x = Math.max(minX + 2, Math.min(maxX - w - 2, Math.round(cx - w / 2)));
    R(x, y, w, 9, '#0d0f1a'); R(x + 1, y + 1, w - 2, 7, bg); text(s, x + 3, y + 2, fg);
    R(cx - 1, y + 9, 3, 1, '#0d0f1a'); R(cx, y + 10, 1, 1, '#0d0f1a');
  }

  function bubbleFor(a, an, now, t) {
    if (an.doneUntil > now) return { s: 'LISTO!', fg: '#0f2b1e', bg: '#8ff0b4' };
    switch (a.status) {
      case 'working': return { s: (a.action || a.task || '...').slice(0, 22), fg: '#0f2b1e', bg: '#b6f2cb' };
      case 'waiting': return { s: '! ' + (a.action || 'atencion').slice(0, 18), fg: '#4a3510', bg: '#ffd166' };
      case 'exhausted': { const left = a.resetAt ? Math.max(0, Math.ceil((a.resetAt - Date.now()) / 60000)) : 0; return { s: left ? `SIN TOKENS ${left}M` : 'SIN TOKENS', fg: '#fff', bg: '#c94b4b' }; }
      default: return api.statusMs(a) > 120000 && an.mode === 'sitting' ? { s: 'Z'.repeat(1 + (Math.floor(t / 600) % 3)), fg: '#e6e9ff', bg: '#5b62c9' } : null;
    }
  }

  function drawRoom(d, list, t, now, sky) {
    const pal = { rug: shade(d.color, -0.05), rugEdge: shade(d.color, -0.25) };
    drawRoomBase(d, list, t, sky);
    const seated = list.slice(0, MAX_SEATS);
    // alfombras
    for (let i = 0; i < MAX_SEATS; i++) drawRug(seatOf(i), seated[i], pal);

    // objetos ordenados por profundidad
    const items = [];
    for (let i = 0; i < MAX_SEATS; i++) { const seat = seatOf(i), a = seated[i]; items.push({ y: seat.sy + 14, f: () => drawDesk(seat, a, anims.get(a?.id), t) }); }
    items.push({ y: 146, f: () => drawSofa(t) }, { y: 140, f: drawCooler }, { y: 60, f: () => drawPlant(240, 50, t) }, { y: 118, f: () => drawPlant(240, 102, t) });
    const overlay = [];
    for (const a of list) {
      const an = anims.get(a.id); if (!an) continue;
      const dim = api.filter() && a.project !== api.filter();
      const seat = seatOf(an.slot);
      const seatedNow = an.mode === 'seated' && seat;
      const key = seatedNow ? seat.y + 1 : an.y;
      let head;
      items.push({
        y: key, f: () => {
          ctx.globalAlpha = dim ? 0.3 : 1;
          if (seatedNow) { drawSeated(seat, a, t); head = seat.sy + 3; }
          else head = drawPerson(an.x, an.y, a, an, t, { walk: an.mode === 'walking', sit: an.mode === 'sitting', wave: an.mode === 'waving' });
          ctx.globalAlpha = 1;
        },
      });
      overlay.push({ a, an, dim, seatedNow, seat });
    }
    items.sort((p, q) => p.y - q.y).forEach((it) => it.f());

    // partículas
    for (const p of parts.get(d.id) || []) { ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max * 1.4)); R(p.x, p.y, p.s, p.s, p.c); }
    ctx.globalAlpha = 1;

    // etiquetas y globos
    for (const o of overlay) {
      const { a, an, dim, seatedNow, seat } = o;
      ctx.globalAlpha = dim ? 0.3 : 1;
      const fx = seatedNow ? seat.x : an.x, fy = seatedNow ? seat.y : an.y + (an.mode === 'sitting' ? 0 : 0);
      const nm = clean(a.name).slice(0, 9), pj = clean(a.project).slice(0, 9);
      // placa oscura detrás de cada línea para que se lea sobre cualquier suelo
      R(fx - textW(nm) / 2 - 1, fy + 1, textW(nm) + 2, 7, 'rgba(10,12,23,.72)');
      text(nm, fx - textW(nm) / 2, fy + 2, shade(a.color, 0.3));
      R(fx - textW(pj) / 2 - 1, fy + 8, textW(pj) + 2, 7, 'rgba(10,12,23,.72)');
      text(pj, fx - textW(pj) / 2, fy + 9, '#c9cfee');
      const b = bubbleFor(a, an, now, t);
      if (b) {
        const by = seatedNow ? seat.sy - 24 : an.y - 32 - (an.mode === 'sitting' ? -4 : 0);
        drawBubble(fx, by, b.s, b.fg, b.bg, 0, RW);
      }
      ctx.globalAlpha = 1;
    }
    if (list.length > MAX_SEATS) text(`+${list.length - MAX_SEATS}`, 4, 40, '#ffd166', '#0d0f1a');
  }

  // ---------- API pública ----------
  function layout() {
    const m = api.model();
    if (api.single()) { W = RW; H = RH; }
    else { const rows = Math.max(1, Math.ceil(m.config.departments.length / 2)); W = RW * 2; H = RH * rows; }
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; ctx.imageSmoothingEnabled = false; }
  }

  function tick() {
    const now = Date.now(), pn = performance.now(), t = pn;
    const dt = Math.min(0.1, (pn - last) / 1000); last = pn;
    const m = api.model();
    updateSim(dt, now);
    ctx.globalAlpha = 1; OX = 0; OY = 0;
    ctx.fillStyle = '#0a0c17'; ctx.fillRect(0, 0, W, H);
    const sky = skyColors();
    const depts = m.config.departments;
    depts.forEach((d, i) => {
      if (api.single() && d.id !== api.room()) return;
      const col = api.single() ? 0 : i % 2, row = api.single() ? 0 : Math.floor(i / 2);
      OX = col * RW; OY = row * RH;
      ctx.save(); ctx.beginPath(); ctx.rect(OX, OY, RW, RH); ctx.clip();
      drawRoom(d, m.agents.filter((a) => a.dept === d.id), t, now, sky);
      R(RW - 1, 0, 1, RH, '#0a0c17'); R(0, RH - 1, RW, 1, '#0a0c17');
      ctx.restore();
    });
    OX = 0; OY = 0;
  }

  return { layout, tick };
}
