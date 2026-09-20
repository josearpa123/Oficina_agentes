// Historial de eventos y consumo en SQLite (node:sqlite, sin dependencias). Si no está disponible, se omite.
import fs from 'node:fs';
import path from 'node:path';

const dayKey = (ms = Date.now()) => new Date(ms).toLocaleDateString('sv'); // YYYY-MM-DD en hora local

export async function openDb(file) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, agent TEXT, session TEXT,
        dept TEXT, project TEXT, type TEXT, text TEXT);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      -- último acumulado visto por sesión (para calcular incrementos)
      CREATE TABLE IF NOT EXISTS session_usage(
        session TEXT PRIMARY KEY, tin INTEGER, tout INTEGER, cost REAL, ts INTEGER);
      -- consumo por día y agente
      CREATE TABLE IF NOT EXISTS daily_usage(
        day TEXT, agent TEXT, tin INTEGER, tout INTEGER, cost REAL, PRIMARY KEY(day, agent));
    `);
    db.prepare('DELETE FROM events WHERE ts < ?').run(Date.now() - 14 * 86400e3);
    db.prepare('DELETE FROM session_usage WHERE ts < ?').run(Date.now() - 14 * 86400e3);
    db.prepare('DELETE FROM daily_usage WHERE day < ?').run(dayKey(Date.now() - 90 * 86400e3));

    const ins = db.prepare('INSERT INTO events(ts,agent,session,dept,project,type,text) VALUES (?,?,?,?,?,?,?)');
    const recent = db.prepare('SELECT ts,agent,session,dept,project,type,text FROM events ORDER BY id DESC LIMIT ?');
    const getSession = db.prepare('SELECT tin,tout,cost FROM session_usage WHERE session = ?');
    const putSession = db.prepare('INSERT INTO session_usage(session,tin,tout,cost,ts) VALUES (?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET tin=excluded.tin, tout=excluded.tout, cost=excluded.cost, ts=excluded.ts');
    const addDaily = db.prepare('INSERT INTO daily_usage(day,agent,tin,tout,cost) VALUES (?,?,?,?,?) ON CONFLICT(day,agent) DO UPDATE SET tin=tin+excluded.tin, tout=tout+excluded.tout, cost=cost+excluded.cost');
    const sumSince = db.prepare('SELECT agent, SUM(tin) tin, SUM(tout) tout, SUM(cost) cost FROM daily_usage WHERE day >= ? GROUP BY agent');

    return {
      insert: (e) => ins.run(e.ts, e.agent, e.id, e.dept, e.project, e.type, e.text),
      recent: (n) => recent.all(Math.min(Math.max(Number(n) || 100, 1), 1000)),

      // u = { session, agent, tin, tout, cost } con contadores ACUMULADOS de la sesión.
      addUsage(u) {
        const prev = getSession.get(u.session) || { tin: 0, tout: 0, cost: 0 };
        // Si el contador baja (sesión reiniciada/compactada) se toma el valor nuevo completo como incremento.
        const d = (now, before) => (now >= before ? now - before : now);
        const dIn = d(u.tin, prev.tin), dOut = d(u.tout, prev.tout), dCost = d(u.cost, prev.cost);
        putSession.run(u.session, u.tin, u.tout, u.cost, Date.now());
        if (dIn || dOut || dCost) addDaily.run(dayKey(), u.agent, dIn, dOut, dCost);
      },

      // { [agent]: { today: {tin,tout,cost}, week: {tin,tout,cost} } }
      totals() {
        const out = {};
        const fill = (rows, slot) => {
          for (const r of rows) (out[r.agent] ??= {})[slot] = { tin: r.tin || 0, tout: r.tout || 0, cost: r.cost || 0 };
        };
        fill(sumSince.all(dayKey()), 'today');
        fill(sumSince.all(dayKey(Date.now() - 6 * 86400e3)), 'week');
        return out;
      },
    };
  } catch (err) {
    console.warn('[db] historial desactivado:', err.message);
    return null;
  }
}
