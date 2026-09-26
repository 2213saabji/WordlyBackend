const express = require('express');
const router = express.Router();

const { dailyContactDigest, weeklyContactDigest, infiniteDailyReset } = require('../controllers/cronController');

// Not behind requireAuth (JWT) — triggered by Vercel Cron and authenticated
// via CRON_SECRET instead. See requireCronSecret in cronController.js.
router.get('/contact-digest-daily', dailyContactDigest);
router.get('/contact-digest-weekly', weeklyContactDigest);
router.post('/infinite-daily-reset', infiniteDailyReset);

module.exports = router;
