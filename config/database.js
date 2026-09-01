// ============================================================
// config/database.js – Duomenų bazės konfigūracija
// ============================================================
// Inicializuoja SQLite duomenų bazę ir sukuria lenteles.
// Jei lentelės jau egzistuoja – jos neperkuriamos.
// ============================================================

const Database = require('better-sqlite3');
const db = new Database('productivity.db');

// Jutiklių duomenų lentelė
db.exec(`
  CREATE TABLE IF NOT EXISTS sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    temperature REAL,
    humidity REAL,
    light REAL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Sistemos įvykių lentelė
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    description TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Darbo režimų lentelė
db.exec(`
  CREATE TABLE IF NOT EXISTS modes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    icon TEXT DEFAULT '◉',
    description TEXT DEFAULT '',
    ledColor TEXT DEFAULT 'blue',
    ledBrightness INTEGER DEFAULT 30,
    fanControl TEXT DEFAULT 'auto',
    fanThreshold REAL DEFAULT 26.0,
    fanManualState INTEGER DEFAULT 0,
    timerDuration REAL DEFAULT 25,
    checkInEnabled INTEGER DEFAULT 0,
    checkInInterval REAL DEFAULT 25,
    checkInTimeout INTEGER DEFAULT 30,
    buzzerOnStart INTEGER DEFAULT 0,
    buzzerOnEnd INTEGER DEFAULT 1,
    buzzerOnCheckIn INTEGER DEFAULT 1,
    missedCheckInAction TEXT DEFAULT 'buzzer',
    servoLockOnStart INTEGER DEFAULT 0,
    isDefault INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Užbaigtų blokų lentelė (dėžutės progresui)
db.exec(`
  CREATE TABLE IF NOT EXISTS completed_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT,
    completedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Dėžutės nustatymų lentelė
db.exec(`
  CREATE TABLE IF NOT EXISTS box_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    unlockTarget INTEGER DEFAULT 3,
    completedBlocks INTEGER DEFAULT 0
  )
`);

// Numatytieji režimai
const modeCount = db.prepare('SELECT COUNT(*) as c FROM modes').get();
if (modeCount.c === 0) {
  const insertMode = db.prepare(`
    INSERT INTO modes (name, icon, description, ledColor, ledBrightness, fanControl, fanThreshold,
      timerDuration, checkInEnabled, checkInInterval, checkInTimeout,
      buzzerOnStart, buzzerOnEnd, buzzerOnCheckIn, missedCheckInAction, servoLockOnStart, isDefault)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertMode.run('Focus', '◉', 'Koncentruotas darbas', 'blue', 30, 'auto', 26.0,
    25, 1, 25, 30, 1, 1, 1, 'stop', 1, 1);

  insertMode.run('Break', '◎', 'Poilsis ir atsipalaidavimas', 'green', 20, 'auto', 26.0,
    0, 0, 25, 30, 0, 1, 0, 'none', 0, 1);
}

// Numatytieji dėžutės nustatymai
const boxCount = db.prepare('SELECT COUNT(*) as c FROM box_settings').get();
if (boxCount.c === 0) {
  db.prepare('INSERT INTO box_settings (id, unlockTarget, completedBlocks) VALUES (1, 3, 0)').run();
}

module.exports = db;
