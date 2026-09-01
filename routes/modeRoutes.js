// ============================================================
// routes/modeRoutes.js – Režimų API maršrutai
// ============================================================

const express = require('express');
const router = express.Router();
const modeService = require('../services/modeService');

// Gauti visus režimus
router.get('/', (req, res) => {
  res.json(modeService.getAllModes());
});

// Gauti vieną režimą
router.get('/:name', (req, res) => {
  const mode = modeService.getMode(req.params.name);
  if (!mode) return res.status(404).json({ error: 'Režimas nerastas' });
  res.json(mode);
});

// Sukurti naują režimą
router.post('/', (req, res) => {
  const result = modeService.createMode(req.body);
  res.status(result.success ? 200 : 400).json(result);
});

// Atnaujinti režimą
router.put('/:name', (req, res) => {
  const result = modeService.updateMode(req.params.name, req.body);
  res.status(result.success ? 200 : 400).json(result);
});

// Ištrinti režimą
router.delete('/:name', (req, res) => {
  const result = modeService.deleteMode(req.params.name);
  res.status(result.success ? 200 : 400).json(result);
});

// Aktyvuoti režimą
router.post('/activate', (req, res) => {
  const result = modeService.activateMode(req.body.mode);
  res.json(result);
});

module.exports = router;
