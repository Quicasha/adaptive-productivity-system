// ============================================================
// websocket/wsServer.js – WebSocket serverio konfigūracija
// ============================================================
// Valdo realaus laiko ryšį su žiniatinklio sąsaja.
// Priima vartotojo komandas ir siunčia sistemos atnaujinimus.
// ============================================================

const WebSocket = require('ws');
const state = require('../services/stateService');
const { activateMode } = require('../services/modeService');
const { confirmCheckIn, getBoxSettings } = require('../services/sessionService');

let wss = null;

// Sukurti WebSocket serverį
function createWSServer(httpServer) {
  wss = new WebSocket.Server({ server: httpServer });

  wss.on('connection', (ws) => {
    console.log('[WebSocket] Nauja UI jungtis');

    // Siunčiame pradinę būseną prisijungus
    const box = getBoxSettings();
    ws.send(JSON.stringify({
      type: 'init',
      data: {
        mode: state.currentMode,
        settings: state.currentModeSettings,
        sensorData: state.latestSensorData,
        espConnected: (Date.now() - state.lastEspMessage) < 10000,
        soundMuted: state.soundMuted,
        session: state.session.active ? {
          active: true,
          startTime: state.session.startTime,
          timerEnd: state.session.timerEnd
        } : { active: false },
        box: {
          completedBlocks: box.completedBlocks,
          unlockTarget: box.unlockTarget
        }
      }
    }));

    // Priimame pranešimus iš UI
    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);

        switch (msg.type) {
          case 'set_mode':
            activateMode(msg.mode);
            break;
          case 'checkin_confirm':
            confirmCheckIn();
            break;
          case 'end_session':
            activateMode('idle');
            break;
        }
      } catch (e) {
        console.error('[WebSocket] Pranešimo klaida:', e.message);
      }
    });
  });

  return wss;
}

// Siųsti pranešimą visiems prisijungusiems klientams
function broadcast(data) {
  if (!wss) return;
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

module.exports = { createWSServer, broadcast };
