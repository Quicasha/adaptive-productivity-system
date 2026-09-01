// ============================================================
// services/dataService.js – Duomenų ir įvykių valdymas
// ============================================================
// Atsakingas už jutiklių duomenų saugojimą, istorijos
// užklausas ir sistemos įvykių registravimą.
// ============================================================

const db = require('../config/database');

let broadcast = null;

function setBroadcast(fn) {
  broadcast = fn;
}

// Registruoti sistemos įvykį
function logEvent(type, description) {
  db.prepare('INSERT INTO events (type, description) VALUES (?, ?)').run(type, description);
  if (broadcast) {
    broadcast({
      type: 'new_event',
      data: { type, description, timestamp: new Date().toISOString() }
    });
  }
}

// Gauti istorinius jutiklių duomenis
function getHistory(period) {
  let timeFilter = "datetime('now', '-24 hours')";
  if (period === '1h') timeFilter = "datetime('now', '-1 hours')";
  else if (period === '6h') timeFilter = "datetime('now', '-6 hours')";
  else if (period === '7d') timeFilter = "datetime('now', '-7 days')";

  return db.prepare(
    `SELECT temperature, humidity, light, timestamp FROM sensor_data WHERE timestamp > ${timeFilter} ORDER BY timestamp`
  ).all();
}

// Gauti įvykių žurnalą
function getEvents(limit = 100) {
  return db.prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT ?').all(limit);
}

// Gauti šiandienos statistiką
function getTodayStats() {
  // Šiandienos užbaigti blokai
  const blocksToday = db.prepare(
    "SELECT COUNT(*) as c FROM completed_blocks WHERE date(completedAt) = date('now')"
  ).get().c;

  // Bendras laikas minutėmis (iš režimų trukmių)
  const blocks = db.prepare(
    "SELECT mode FROM completed_blocks WHERE date(completedAt) = date('now')"
  ).all();

  let totalMinutes = 0;
  blocks.forEach(b => {
    const mode = db.prepare('SELECT timerDuration FROM modes WHERE name = ? COLLATE NOCASE').get(b.mode);
    if (mode && mode.timerDuration > 0) totalMinutes += mode.timerDuration;
  });

  // Dienų serija (streak) – kiek iš eilės dienų buvo bent 1 blokas
  let streak = 0;
  let checkDate = new Date();
  while (true) {
    const dateStr = checkDate.toISOString().split('T')[0];
    const count = db.prepare(
      "SELECT COUNT(*) as c FROM completed_blocks WHERE date(completedAt) = ?"
    ).get(dateStr).c;

    if (count > 0) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  return { blocksToday, totalMinutes: Math.round(totalMinutes), streak };
}

module.exports = { logEvent, getHistory, getEvents, getTodayStats, setBroadcast };
