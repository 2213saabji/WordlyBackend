const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const {
  requireRewardEligible,
  status,
  sendMobileOtp,
  verifyMobileOtp,
  sendEmailLink,
  confirmEmail,
  submitBank,
} = require('../controllers/verificationController');

// Public: opened from the emailed link, possibly signed out. The token is
// the credential.
router.post('/email/confirm', confirmEmail);

router.use(requireAuth, requireRewardEligible);

router.get('/status', status);
router.post('/mobile/otp', sendMobileOtp);
router.post('/mobile/verify', verifyMobileOtp);
router.post('/email/send', sendEmailLink);
router.post('/bank', submitBank);

module.exports = router;
