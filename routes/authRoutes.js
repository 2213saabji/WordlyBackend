const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const {
  signup,
  login,
  refresh,
  logout,
  me,
  forgotPassword,
  resetPassword,
} = require('../controllers/authController');

router.post('/signup', signup);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', requireAuth, logout);
router.get('/me', requireAuth, me);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);

module.exports = router;
