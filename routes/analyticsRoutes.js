const express = require('express');
const router = express.Router();

const { signupLocations } = require('../controllers/analyticsController');

// Not behind requireAuth (JWT): server-to-server, authenticated with
// CRON_SECRET inside the handler, like routes/cronRoutes.js.
router.get('/signup-locations', signupLocations);

module.exports = router;
