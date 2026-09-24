const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const {
  createGroup,
  joinGroup,
  myGroups,
  updateGroupName,
  leaveGroup,
  leaderboard,
  dailyLeaderboard,
  weeklyLeaderboard,
} = require('../controllers/groupController');

router.use(requireAuth);

router.post('/', createGroup);
router.get('/mine', myGroups);
router.post('/join/:code', joinGroup);
router.patch('/:id', updateGroupName);
router.post('/:id/leave', leaveGroup);
router.get('/:id/leaderboard', leaderboard);
router.get('/:id/leaderboard/daily', dailyLeaderboard);
router.get('/:id/leaderboard/weekly', weeklyLeaderboard);

module.exports = router;
