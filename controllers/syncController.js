const { getTierConfig } = require('../utils/tierConfig');
const { currentSyncValues, diffSync } = require('../utils/sync');

// GET /sync?since=<syncToken>
// Which of the caller's APIs may have changed since the app last fetched
// them: { syncToken, changed: { me: false, mine: true, … } }. The app calls
// only the APIs marked true, then stores the new syncToken for next time.
// No `since` (first sync, or the app lost its token) marks everything true.
async function sync(req, res) {
  const since = typeof req.query.since === 'string' ? req.query.since : undefined;
  const config = await getTierConfig();
  const values = await currentSyncValues(req.userId, config);
  const { changed, syncToken } = diffSync(since, values);

  // Per-user and changes on every call: never let a CDN or browser reuse it.
  res.set('Cache-Control', 'no-store');
  return res.json({ syncToken, changed });
}

module.exports = { sync };
