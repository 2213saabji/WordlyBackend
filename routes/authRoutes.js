const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const {
  signup,
  login,
  googleAuth,
  refresh,
  logout,
  me,
  updateUsername,
  forgotPassword,
  resetPassword,
} = require('../controllers/authController');

router.post('/signup', signup);
router.post('/login', login);
router.post('/google', googleAuth);
router.post('/refresh', refresh);
router.post('/logout', requireAuth, logout);
router.get('/me', requireAuth, me);
router.patch('/username', requireAuth, updateUsername);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);

module.exports = router;
