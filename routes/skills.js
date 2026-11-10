// routes/skills.js - list of all skills (used to fill dropdowns)
const router = require('express').Router();
const db = require('../db');
const { wrap } = require('../auth');

// GET /api/skills
router.get('/skills', wrap(async (req, res) => {
  res.json(await db.all('SELECT id, name FROM skills ORDER BY name'));
}));

module.exports = router;
