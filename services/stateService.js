// ============================================================
// services/stateService.js – Bendra sistemos būsena
// ============================================================
// Saugo dabartinę sistemos būseną atmintyje.
// Naudojama visų kitų modulių.
// ============================================================

module.exports = {
  latestSensorData: {},       // Paskutiniai jutiklių duomenys
  currentMode: 'idle',        // Aktyvus režimas
  currentModeSettings: null,  // Aktyvaus režimo nustatymai
  manualFanOverride: null,    // Rankinis ventiliatoriaus valdymas
  soundMuted: false,          // Garso nutildymas
  lastEspMessage: 0,          // Paskutinio ESP32 pranešimo laikas

  // Aktyvumo patikrinimo būsena
  checkIn: {
    active: false,
    timer: null,
    timeoutTimer: null,
    status: 'idle'            // idle | waiting | confirmed | missed
  },

  // Sesijos būsena
  session: {
    active: false,
    startTime: null,
    timerEnd: null,
    blockTimer: null
  }
};
