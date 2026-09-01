// ============================================================
// routes/controlRoutes.js – Rankinio valdymo API maršrutai
// ============================================================

const express = require('express');
const router = express.Router();
const state = require('../services/stateService');
const { sendToESP } = require('../mqtt/mqttClient');
const { logEvent } = require('../services/dataService');
const sessionService = require('../services/sessionService');

// Ventiliatoriaus valdymas
router.post('/fan', (req, res) => {
  const { state: fanState } = req.body;
  state.manualFanOverride = fanState;
  sendToESP('server/commands/fan', fanState ? 'on' : 'off');
  logEvent('ventiliatorius', `Ventiliatorius ${fanState ? 'įjungtas' : 'išjungtas'} rankiniu būdu`);
  res.json({ success: true });
});

// LED valdymas
router.post('/led', (req, res) => {
  const { color, brightness } = req.body;
  sendToESP('server/commands/led', `${color},${brightness}`);
  logEvent('led', `LED nustatytas: ${color}, ryškumas ${brightness}`);
  res.json({ success: true });
});

// Garso signalas
router.post('/buzzer', (req, res) => {
  if (!state.soundMuted) {
    sendToESP('server/commands/buzzer', 'beep');
  }
  res.json({ success: true });
});

// Servo valdymas
router.post('/servo', (req, res) => {
  const { locked } = req.body;
  sendToESP('server/commands/servo', locked ? 'lock' : 'unlock');
  logEvent('dezute', `Dėžutė ${locked ? 'užrakinta' : 'atrakinta'} rankiniu būdu`);
  res.json({ success: true });
});

// Garso nutildymas
router.post('/sound', (req, res) => {
  state.soundMuted = req.body.muted;
  res.json({ success: true, muted: state.soundMuted });
});

// Aktyvumo patikrinimo patvirtinimas
router.post('/checkin/confirm', (req, res) => {
  sessionService.confirmCheckIn();
  res.json({ success: true });
});

// Dėžutės nustatymai
router.get('/box', (req, res) => {
  res.json(sessionService.getBoxSettings());
});

router.put('/box', (req, res) => {
  sessionService.updateBoxTarget(req.body.unlockTarget);
  res.json({ success: true });
});

router.post('/box/reset', (req, res) => {
  sessionService.resetBox();
  res.json({ success: true });
});

module.exports = router;
