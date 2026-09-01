// ============================================================
// services/modeService.js – Režimų valdymo logika
// ============================================================
// Atsakingas už režimų kūrimą, redagavimą, trynimą
// ir aktyvavimą su visa susijusia logika.
// ============================================================

const db = require('../config/database');
const state = require('./stateService');
const { sendToESP } = require('../mqtt/mqttClient');
const { logEvent } = require('./dataService');
const sessionService = require('./sessionService');

let broadcast = null;

function setBroadcast(fn) {
  broadcast = fn;
}

// Gauti visus režimus
function getAllModes() {
  return db.prepare('SELECT * FROM modes ORDER BY isDefault DESC, name ASC').all();
}

// Gauti vieną režimą
function getMode(name) {
  return db.prepare('SELECT * FROM modes WHERE name = ? COLLATE NOCASE').get(name);
}

// Sukurti naują režimą
function createMode(data) {
  const { name, icon, description, ledColor, ledBrightness, fanControl, fanThreshold,
    timerDuration, checkInEnabled, checkInInterval, checkInTimeout,
    buzzerOnStart, buzzerOnEnd, buzzerOnCheckIn, missedCheckInAction, servoLockOnStart } = data;

  if (!name || name.trim() === '') {
    return { success: false, error: 'Režimo pavadinimas privalomas' };
  }

  const existing = db.prepare('SELECT id FROM modes WHERE name = ? COLLATE NOCASE').get(name);
  if (existing) {
    return { success: false, error: 'Režimas tokiu pavadinimu jau egzistuoja' };
  }

  try {
    db.prepare(`
      INSERT INTO modes (name, icon, description, ledColor, ledBrightness, fanControl, fanThreshold,
        timerDuration, checkInEnabled, checkInInterval, checkInTimeout,
        buzzerOnStart, buzzerOnEnd, buzzerOnCheckIn, missedCheckInAction, servoLockOnStart, isDefault)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(name, icon || '◉', description || '', ledColor || 'blue', ledBrightness || 30,
      fanControl || 'auto', fanThreshold || 26.0, timerDuration || 25,
      checkInEnabled ? 1 : 0, checkInInterval || 25, checkInTimeout || 30,
      buzzerOnStart ? 1 : 0, buzzerOnEnd ? 1 : 0, buzzerOnCheckIn ? 1 : 0,
      missedCheckInAction || 'buzzer', servoLockOnStart ? 1 : 0);

    logEvent('rezimas', `Sukurtas naujas režimas: ${name}`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Atnaujinti režimą
function updateMode(name, data) {
  const mode = getMode(name);
  if (!mode) return { success: false, error: 'Režimas nerastas' };

  const { icon, description, ledColor, ledBrightness, fanControl, fanThreshold,
    timerDuration, checkInEnabled, checkInInterval, checkInTimeout,
    buzzerOnStart, buzzerOnEnd, buzzerOnCheckIn, missedCheckInAction, servoLockOnStart } = data;

  try {
    db.prepare(`
      UPDATE modes SET icon=?, description=?, ledColor=?, ledBrightness=?, fanControl=?, fanThreshold=?,
        timerDuration=?, checkInEnabled=?, checkInInterval=?, checkInTimeout=?,
        buzzerOnStart=?, buzzerOnEnd=?, buzzerOnCheckIn=?, missedCheckInAction=?, servoLockOnStart=?
      WHERE name = ? COLLATE NOCASE
    `).run(
      icon ?? mode.icon, description ?? mode.description,
      ledColor ?? mode.ledColor, ledBrightness ?? mode.ledBrightness,
      fanControl ?? mode.fanControl, fanThreshold ?? mode.fanThreshold,
      timerDuration ?? mode.timerDuration,
      checkInEnabled !== undefined ? (checkInEnabled ? 1 : 0) : mode.checkInEnabled,
      checkInInterval ?? mode.checkInInterval, checkInTimeout ?? mode.checkInTimeout,
      buzzerOnStart !== undefined ? (buzzerOnStart ? 1 : 0) : mode.buzzerOnStart,
      buzzerOnEnd !== undefined ? (buzzerOnEnd ? 1 : 0) : mode.buzzerOnEnd,
      buzzerOnCheckIn !== undefined ? (buzzerOnCheckIn ? 1 : 0) : mode.buzzerOnCheckIn,
      missedCheckInAction ?? mode.missedCheckInAction,
      servoLockOnStart !== undefined ? (servoLockOnStart ? 1 : 0) : mode.servoLockOnStart,
      name
    );

    // Jei redaguojamas aktyvus režimas – atnaujiname
    if (state.currentMode.toLowerCase() === name.toLowerCase()) {
      state.currentModeSettings = getMode(name);
      sendToESP('server/commands/led', `${state.currentModeSettings.ledColor},${state.currentModeSettings.ledBrightness}`);
    }

    logEvent('rezimas', `Režimas atnaujintas: ${name}`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Ištrinti režimą
function deleteMode(name) {
  const mode = getMode(name);
  if (!mode) return { success: false, error: 'Režimas nerastas' };
  if (mode.isDefault) return { success: false, error: 'Negalima ištrinti numatytojo režimo' };

  if (state.currentMode.toLowerCase() === name.toLowerCase()) {
    activateMode('idle');
  }

  db.prepare('DELETE FROM modes WHERE name = ? COLLATE NOCASE').run(name);
  logEvent('rezimas', `Režimas ištrintas: ${name}`);
  return { success: true };
}

// Aktyvuoti režimą
function activateMode(modeName) {
  sessionService.stopSession();

  if (modeName === 'idle') {
    state.currentMode = 'idle';
    state.currentModeSettings = null;
    state.manualFanOverride = null;
    sendToESP('server/commands/mode', 'idle');
    logEvent('rezimas', 'Režimas sustabdytas → Idle');
    if (broadcast) broadcast({ type: 'mode_update', data: { mode: 'idle', settings: null, session: null } });
    return { success: true, mode: 'idle' };
  }

  const modeData = getMode(modeName);
  if (!modeData) return { success: false, error: 'Režimas nerastas' };

  state.currentMode = modeData.name;
  state.currentModeSettings = modeData;
  state.manualFanOverride = null;

  // ESP32 komandos
  sendToESP('server/commands/mode', modeData.name.toLowerCase());
  sendToESP('server/commands/led', `${modeData.ledColor},${modeData.ledBrightness}`);
  sendToESP('server/commands/threshold', String(modeData.fanThreshold));

  if (modeData.servoLockOnStart) sendToESP('server/commands/servo', 'lock');
  if (modeData.buzzerOnStart && !state.soundMuted) sendToESP('server/commands/buzzer', 'beep');

  logEvent('rezimas', `Režimas pakeistas → ${modeData.name}`);

  sessionService.startSession(modeData);

  if (broadcast) {
    broadcast({
      type: 'mode_update',
      data: {
        mode: modeData.name,
        settings: modeData,
        session: {
          active: true,
          startTime: state.session.startTime,
          timerEnd: state.session.timerEnd,
          timerDuration: modeData.timerDuration
        }
      }
    });
  }

  return { success: true, mode: modeData.name, settings: modeData };
}

module.exports = { getAllModes, getMode, createMode, updateMode, deleteMode, activateMode, setBroadcast };
