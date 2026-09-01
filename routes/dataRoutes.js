// ============================================================
// routes/dataRoutes.js – Duomenų API maršrutai
// ============================================================

const express = require('express');
const router = express.Router();
const dataService = require('../services/dataService');
const state = require('../services/stateService');
const sessionService = require('../services/sessionService');

// Sistemos būsena
router.get('/state', (req, res) => {
  const box = sessionService.getBoxSettings();
  res.json({
    mode: state.currentMode,
    settings: state.currentModeSettings,
    data: state.latestSensorData,
    espConnected: (Date.now() - state.lastEspMessage) < 10000,
    soundMuted: state.soundMuted,
    session: state.session.active ? {
      active: true,
      startTime: state.session.startTime,
      timerEnd: state.session.timerEnd
    } : { active: false },
    checkIn: {
      status: state.checkIn.status,
      active: state.checkIn.active
    },
    box: {
      completedBlocks: box.completedBlocks,
      unlockTarget: box.unlockTarget
    }
  });
});

// Istoriniai jutiklių duomenys
router.get('/history', (req, res) => {
  res.json(dataService.getHistory(req.query.period));
});

// Įvykių žurnalas
router.get('/events', (req, res) => {
  res.json(dataService.getEvents());
});

// Šiandienos statistika
router.get('/stats/today', (req, res) => {
  res.json(dataService.getTodayStats());
});

module.exports = router;
