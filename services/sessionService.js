// ============================================================
// services/sessionService.js – Sesijų ir patikrinimų valdymas
// ============================================================
// Atsakingas už Pomodoro laikmatį, aktyvumo patikrinimus
// (check-in) ir dėžutės progreso skaičiavimą.
// ============================================================

const db = require('../config/database');
const state = require('./stateService');
const { sendToESP } = require('../mqtt/mqttClient');
const { logEvent } = require('./dataService');

let broadcast = null;

function setBroadcast(fn) {
  broadcast = fn;
}

// ============================================================
// SESIJOS VALDYMAS (Pomodoro)
// ============================================================

function startSession(modeData) {
  state.session.active = true;
  state.session.startTime = Date.now();

  // Pomodoro laikmatis tik jei timerDuration > 0
  if (modeData.timerDuration > 0) {
    state.session.timerEnd = Date.now() + (modeData.timerDuration * 60 * 1000);

    state.session.blockTimer = setTimeout(() => {
      onBlockComplete();
    }, modeData.timerDuration * 60 * 1000);
  } else {
    state.session.timerEnd = null;
  }

  // Aktyvumo patikrinimas
  if (modeData.checkInEnabled) {
    startCheckInTimer(modeData);
  }
}

function stopSession() {
  state.session.active = false;
  state.session.startTime = null;
  state.session.timerEnd = null;

  if (state.session.blockTimer) {
    clearTimeout(state.session.blockTimer);
    state.session.blockTimer = null;
  }

  stopCheckIn();
}

// Kai Pomodoro blokas baigiasi
function onBlockComplete() {
  if (!state.currentModeSettings) return;

  // Garso signalas pabaigoje
  if (state.currentModeSettings.buzzerOnEnd && !state.soundMuted) {
    sendToESP('server/commands/buzzer', 'beep');
  }

  // Registruojame užbaigtą bloką
  db.prepare('INSERT INTO completed_blocks (mode) VALUES (?)').run(state.currentMode);
  logEvent('blokas', `Užbaigtas ${state.currentMode} blokas (${state.currentModeSettings.timerDuration} min)`);

  // Dėžutės progresas
  const box = db.prepare('SELECT * FROM box_settings WHERE id = 1').get();
  const newCompleted = box.completedBlocks + 1;
  const justUnlocked = newCompleted >= box.unlockTarget;

  if (justUnlocked) {
    // Resetiname tik DB'e (kitam ciklui), bet frontendui siunčiame faktinį pasiekimą
    db.prepare('UPDATE box_settings SET completedBlocks = 0 WHERE id = 1').run();
    sendToESP('server/commands/servo', 'unlock');
    logEvent('dezute', `Dėžutė atrakinta! Pasiektas tikslas: ${box.unlockTarget} blokai`);
    if (broadcast) broadcast({ type: 'box_unlocked', data: { target: box.unlockTarget } });
  } else {
    db.prepare('UPDATE box_settings SET completedBlocks = ? WHERE id = 1').run(newCompleted);
  }

  stopSession();

  if (broadcast) {
    broadcast({
      type: 'block_complete',
      data: {
        mode: state.currentMode,
        duration: state.currentModeSettings.timerDuration,
        // Siunčiame faktinį pasiektą skaičių (pvz. 1/1), nepriklausomai nuo reset
        completedBlocks: newCompleted,
        unlockTarget: box.unlockTarget,
        justUnlocked: justUnlocked
      }
    });
  }

  // Grąžiname į idle
  state.currentMode = 'idle';
  state.currentModeSettings = null;
  sendToESP('server/commands/mode', 'idle');
  if (broadcast) broadcast({ type: 'mode_update', data: { mode: 'idle', settings: null, session: null } });
}

// ============================================================
// AKTYVUMO PATIKRINIMAS (Check-in)
// ============================================================

function startCheckInTimer(modeData) {
  stopCheckIn();

  state.checkIn.active = true;
  state.checkIn.status = 'idle';

  state.checkIn.timer = setInterval(() => {
    triggerCheckIn();
  }, modeData.checkInInterval * 60 * 1000);
}

function triggerCheckIn() {
  if (!state.currentModeSettings) return;

  // Apsauga: jei jau laukiame patvirtinimo iš ankstesnio patikrinimo - neinicijuojam naujo.
  // Šis atvejis pasitaiko kai checkInInterval < checkInTimeout (pvz. testuojant
  // su trumpais laikais: interval=15s, timeout=30s - kitas trigger'is ateina
  // anksčiau nei pasibaigia laukimas).
  if (state.checkIn.status === 'waiting') return;

  state.checkIn.status = 'waiting';

  if (state.currentModeSettings.buzzerOnCheckIn && !state.soundMuted) {
    sendToESP('server/commands/buzzer', 'beep');
  }

  logEvent('patikrinimas', 'Aktyvumo patikrinimas inicijuotas');

  if (broadcast) {
    broadcast({
      type: 'checkin_request',
      data: { timeout: state.currentModeSettings.checkInTimeout }
    });
  }

  state.checkIn.timeoutTimer = setTimeout(() => {
    onCheckInMissed();
  }, state.currentModeSettings.checkInTimeout * 1000);
}

function confirmCheckIn() {
  if (state.checkIn.status !== 'waiting') return;

  state.checkIn.status = 'confirmed';
  if (state.checkIn.timeoutTimer) {
    clearTimeout(state.checkIn.timeoutTimer);
    state.checkIn.timeoutTimer = null;
  }

  logEvent('patikrinimas', 'Aktyvumo patikrinimas patvirtintas ✓');
  if (broadcast) broadcast({ type: 'checkin_confirmed' });
}

function onCheckInMissed() {
  state.checkIn.status = 'missed';
  logEvent('praleista', 'Aktyvumo patikrinimas praleistas ✗');

  if (!state.currentModeSettings) return;

  // Importuojame activateMode čia kad išvengtume ciklinės priklausomybės
  const { activateMode } = require('./modeService');

  switch (state.currentModeSettings.missedCheckInAction) {
    case 'buzzer':
      if (!state.soundMuted) sendToESP('server/commands/buzzer', 'beep');
      break;
    case 'break':
      activateMode('Break');
      break;
    case 'stop':
      activateMode('idle');
      break;
  }

  if (broadcast) {
    broadcast({
      type: 'checkin_missed',
      data: { action: state.currentModeSettings.missedCheckInAction }
    });
  }
}

function stopCheckIn() {
  state.checkIn.active = false;
  state.checkIn.status = 'idle';

  if (state.checkIn.timer) { clearInterval(state.checkIn.timer); state.checkIn.timer = null; }
  if (state.checkIn.timeoutTimer) { clearTimeout(state.checkIn.timeoutTimer); state.checkIn.timeoutTimer = null; }
}

// ============================================================
// DĖŽUTĖS VALDYMAS
// ============================================================

function getBoxSettings() {
  return db.prepare('SELECT * FROM box_settings WHERE id = 1').get();
}

function updateBoxTarget(unlockTarget) {
  if (unlockTarget && unlockTarget > 0) {
    db.prepare('UPDATE box_settings SET unlockTarget = ? WHERE id = 1').run(unlockTarget);
  }
}

function resetBox() {
  db.prepare('UPDATE box_settings SET completedBlocks = 0 WHERE id = 1').run();
  sendToESP('server/commands/servo', 'lock');
  logEvent('dezute', 'Dėžutės progresas atstatytas');
}

module.exports = {
  startSession, stopSession, confirmCheckIn,
  getBoxSettings, updateBoxTarget, resetBox,
  setBroadcast
};
