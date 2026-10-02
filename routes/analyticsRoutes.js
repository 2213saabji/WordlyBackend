const express = require('express');
const router = express.Router();

const { authLocations } = require('../controllers/analyticsController');

// Not behind requireAuth (JWT): server-to-server, authenticated with
// CRON_SECRET inside the handler, like routes/cronRoutes.js.
router.get('/auth-locations', authLocations);

module.exports = router;
