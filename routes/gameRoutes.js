const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const {
  getToday,
  submitGuess,
  history,
  getCurrentInfinite,
  newInfiniteGame,
  submitInfiniteGuess,
  infiniteHistory,
} = require('../controllers/gameController');

router.use(requireAuth);

router.get('/today', getToday);
router.post('/guess', submitGuess);
router.get('/history', history);

router.get('/infinite/current', getCurrentInfinite);
router.post('/infinite/new', newInfiniteGame);
router.post('/infinite/guess', submitInfiniteGuess);
router.get('/infinite/history', infiniteHistory);

module.exports = router;
