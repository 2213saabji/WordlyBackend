const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const {
  registrationOptions,
  registrationVerify,
  authenticationOptions,
  authenticationVerify,
  listDevices,
  revoke,
} = require('../controllers/webauthnController');

// Enrolling a passkey requires being already signed in (normal login first).
router.post('/register/options', requireAuth, registrationOptions);
router.post('/register/verify', requireAuth, registrationVerify);

// Authenticating via passkey is how you get back in with NO existing
// session/deviceId - so these are deliberately public.
router.post('/authenticate/options', authenticationOptions);
router.post('/authenticate/verify', authenticationVerify);

router.get('/devices', requireAuth, listDevices);
router.post('/revoke', requireAuth, revoke);

module.exports = router;
