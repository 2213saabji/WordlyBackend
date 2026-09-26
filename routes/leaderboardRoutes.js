const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { daily, weekly, infinite } = require('../controllers/leaderboardController');

router.use(requireAuth);

router.get('/daily', daily);
router.get('/weekly', weekly);
router.get('/infinite', infinite);

module.exports = router;
