// ============================================================
// mqtt/mqttClient.js – MQTT komunikacija su ESP32
// ============================================================
// Jungiasi prie Mosquitto brokerio, priima jutiklių duomenis
// iš ESP32 ir siunčia valdymo komandas.
// ============================================================

const mqtt = require('mqtt');
const db = require('../config/database');
const state = require('../services/stateService');

let broadcast = null; // Nustatomas vėliau per setBroadcast()

const mqttClient = mqtt.connect('mqtt://localhost:1883');

mqttClient.on('connect', () => {
  console.log('[MQTT] Prisijungta prie brokerio');
  mqttClient.subscribe('esp32/data');
});

mqttClient.on('message', (topic, message) => {
  if (topic === 'esp32/data') {
    try {
      const data = JSON.parse(message.toString());
      data.timestamp = new Date().toISOString();

      // Atnaujiname sistemos būseną
      state.latestSensorData = data;
      state.lastEspMessage = Date.now();

      // Išsaugome duomenų bazėje
      db.prepare('INSERT INTO sensor_data (temperature, humidity, light) VALUES (?, ?, ?)')
        .run(data.temperature, data.humidity, data.light);

      // Siunčiame UI per WebSocket
      if (broadcast) {
        broadcast({
          type: 'sensor_update',
          data: { ...data, espConnected: true }
        });
      }
    } catch (e) {
      console.error('[MQTT] Duomenų apdorojimo klaida:', e.message);
    }
  }
});

// ESP32 prisijungimo tikrinimas kas 5 sekundes
setInterval(() => {
  const espConnected = (Date.now() - state.lastEspMessage) < 10000;
  if (broadcast) {
    broadcast({ type: 'esp_status', data: { connected: espConnected } });
  }
}, 5000);

// Siųsti MQTT komandą ESP32
function sendToESP(topic, payload) {
  mqttClient.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

// Nustatyti broadcast funkciją (iškviečiama iš index.js)
function setBroadcast(fn) {
  broadcast = fn;
}

module.exports = { mqttClient, sendToESP, setBroadcast };
