// ============================================================
// index.js – Pagrindinis serverio paleidimo failas
// ============================================================
// Inicializuoja visus modulius ir paleidžia serverį.
// ============================================================

const express = require('express');
const path = require('path');

// Moduliai
const db = require('./config/database');
const { setBroadcast: setMqttBroadcast } = require('./mqtt/mqttClient');
const { createWSServer, broadcast } = require('./websocket/wsServer');
const { setBroadcast: setDataBroadcast } = require('./services/dataService');
const { setBroadcast: setModeBroadcast } = require('./services/modeService');
const { setBroadcast: setSessionBroadcast } = require('./services/sessionService');

// Maršrutai
const modeRoutes = require('./routes/modeRoutes');
const controlRoutes = require('./routes/controlRoutes');
const dataRoutes = require('./routes/dataRoutes');

// ============================================================
// EXPRESS KONFIGŪRACIJA
// ============================================================

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API maršrutai
app.use('/api/modes', modeRoutes);
app.use('/api/mode', modeRoutes);    // /api/mode/activate
app.use('/api', controlRoutes);       // /api/fan, /api/led, /api/buzzer, /api/servo, /api/sound, /api/checkin, /api/box
app.use('/api', dataRoutes);          // /api/state, /api/history, /api/events

// ============================================================
// SERVERIO PALEIDIMAS
// ============================================================

const PORT = 3000;
const server = app.listen(PORT, () => {
  console.log(`[Serveris] Veikia adresu http://localhost:${PORT}`);
});

// WebSocket serverio sukūrimas
createWSServer(server);

// Nustatome broadcast funkciją visiems moduliams
setMqttBroadcast(broadcast);
setDataBroadcast(broadcast);
setModeBroadcast(broadcast);
setSessionBroadcast(broadcast);

console.log('[Sistema] Visi moduliai inicializuoti, laukiama prisijungimų...');
