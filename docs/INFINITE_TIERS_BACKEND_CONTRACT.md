# Infinite Mode Tier Leaderboard — Backend Contract

Draft v0.1 · 26 Sep 2026 · Based on PRD "Infinite Mode Tier Leaderboard" v0.1

This document defines the data model, rules engine, and HTTP contract for the tiered
Infinite leaderboard, and lists every change needed to the existing backend. All paths
are under `/api`, all authenticated routes use the existing `requireAuth` Bearer JWT,
and all errors keep the existing `{ "message": "..." }` shape plus a machine-readable `code`.

---

## 0. Key decisions at a glance

| Topic | Decision |
|---|---|
| Day boundary | New `istDayKey()` (UTC+05:30). Infinite mode uses IST; Daily mode stays on UTC `todayKey()` as today (PRD: Daily unchanged). |
| Source of truth for consistency | One `InfiniteDay` document per user per IST day. Everything else (streaks, misses, reward counter) is derived from it. |
| No-show day | A day with no activity is a **missed** day (tiers 1–7). Otherwise players could avoid demotion by not playing. |
| Active time | Server-side heartbeats, credited by **wall-clock delta per user** (not per request), so extra tabs can't double-count. |
| Ranking | Computed live from an indexed `TierMembership` collection. No stored rank. A tier change re-orders both tiers immediately. |
| Promotion/demotion | Run only in the daily reset job, which is idempotent, batched, and catches up if the cron runs late. |
| Top 25% check | Uses a per-tier **cutoff score snapshot** taken at the start of the job, so promotions processed earlier in the job don't shift the bar for later ones. |
| Tier change | Carried-in score = `floor(0.20 × old score)`; qualifying-days-in-tier = 0; tie-break timestamp = time of the move. Streak and 7-day window reset. |
| Hints | Removed from the game payload and moved to a new `POST /game/infinite/hint` that returns 403 for Tier 6 and above. |
| Scoring idempotency | A game is scored once, guarded by `Game.scoredAt` (the current guess handler can race). |
| Config | Thresholds live in a `TierConfig` document (cached ~60 s). Changes apply from the **next** IST day; each `InfiniteDay` snapshots its targets. |

---

## 1. Existing code that shapes this design

| Finding | Where | Impact |
|---|---|---|
| `todayKey()` is UTC (`toISOString().slice(0,10)`). | `utils/dailyWord.js` | The PRD needs a 00:00 IST reset. Add `istDayKey()` and don't change `todayKey()`. |
| `serializeGame()` always includes `hint`, even mid-game. There's no hint API to block. | `controllers/gameController.js` | "Hints off" has to be enforced by removing `hint` from the payload. See §7.1. |
| `difficulty` is sent before the first guess, and `POST /infinite/new` skips a word at no cost. | `gameController.js` | Players can **cherry-pick** easy words: skip every "hard" one, play only easy ones for more points per game. See §8 and Q4. |
| The infinite word order is seeded only from `userId` with a plain string hash. `userId` appears in leaderboard responses. | `utils/dailyWord.js` `infiniteAnswerOrder` | Anyone who has the algorithm and word list can predict a player's next word. Tolerable for casual play, not with cash rewards. Seed with an HMAC using a server secret. |
| `submitInfiniteGuess` does read → push → `save()` with no guard. Two concurrent requests can both complete the game. | `gameController.js` | Scoring must be idempotent (`scoredAt` guard). |
| Leaderboards rank in memory (`find()` everything, sort, slice). | `utils/leaderboard.js` `paginate` | Fine for daily/weekly. Tier boards need DB-side sort and pagination plus a count query for rank. |
| Crons run from GitHub Actions calling Vercel endpoints. | `.github/workflows/contact-digests.yml` | GH Actions schedules can run 5–60 min late, and Vercel functions have short timeouts. The reset job must be idempotent, batched and resumable. |
| No rate limiting, no admin role. | `server.js`, `middleware/auth.js` | Heartbeats, OTP and hint need rate limits. Manual review and payouts need `requireAdmin`. |
| `DeviceSession` already stores a `deviceId` per user. | `models/DeviceSession.js` | Reuse it for linked-account detection (§8). |

---

## 2. Data model

### 2.1 New collections

**`TierMembership`** — one per Infinite player. Created when the player completes their first Infinite game after launch, starting in Tier 8.

```js
{
  user: ObjectId,               // unique
  tier: 1..8,
  enteredTierAt: Date,
  enteredTierDay: 'YYYY-MM-DD', // IST day
  score: Number,                // tier score, reset on tier change (carry-in 20%)
  qualifyingDaysInTier: Number, // tie-break #1 (total, not consecutive)
  scoreReachedAt: Date,         // tie-break #2, set on every score change
  qualifyingStreak: Number,     // consecutive qualifying days in this tier → promotion
  window: [{ day, qualified }], // last ≤7 settled days *in this tier* ($push + $slice: -7)
  missesInWindow: Number,       // denormalised count of qualified:false in window
  lastSettledDay: 'YYYY-MM-DD', // reset-job idempotency cursor
  lastActiveDay: 'YYYY-MM-DD',  // for "active member" population in the top-25% rule
  // Tier 1 reward (Phase 2)
  rewardStreak: Number,         // 0..30, resets on any missed day or leaving Tier 1
  rewardCycle: Number,          // increments each time a payout is created
}
// Indexes
{ user: 1 } unique
{ tier: 1, score: -1, qualifyingDaysInTier: -1, scoreReachedAt: 1 }  // ranking + list
{ tier: 1, lastSettledDay: 1 }                                         // reset job batches
```

**`InfiniteDay`** — one per user per IST day with activity. It's the base unit of consistency.

```js
{
  user, day: 'YYYY-MM-DD',       // unique (user, day)
  tier,                          // tier the day is judged against (tier at day start)
  targetMinutes, targetGames,    // snapshotted from TierConfig on first write that day
  activeMs: Number,
  lastHeartbeatAt: Date,
  gamesCompleted, gamesWon, pointsEarned,
  qualified: Boolean, qualifiedAt: Date,  // set in real time when both targets are met
  bonusAwarded: Boolean,                  // +20 guard
}
```

**`TierChange`** — append-only log, used for notifications, the "moved from #12 in Bronze to #28 in Silver" UI, and audits.

```js
{ user, day, fromTier, toTier, reason: 'promotion'|'demotion'|'seed'|'admin',
  oldScore, oldRank, oldTierSize, carriedScore, rankAtEntry, newTierSize, createdAt }
```

**`TierConfig`** — a single document with a version number. Changes apply from the next IST day.

```js
{ version, tiers: [{ tier, name, hintsEnabled, minActiveMinutes, minGamesCompleted, rewardInr }],
  scoring: { solveBase: 10, perUnusedGuess: 2, lossPoints: 0, qualifyingDayBonus: 20 },
  promotion: { consecutiveDays: 7, topPercent: 25, activeWithinDays: 7 },
  demotion: { misses: 3, windowDays: 7 },
  carryInPercent: 20,
  activity: { maxHeartbeatGapMs: 45000, idleInputMs: 60000, requireGuessWithinMs: 180000 },
  lossCountsTowardTarget: true, tier8RequiresOneGame: true }
```

**Phase 2:** `Verification` (per user: phone/email/bank status, masked values, encrypted bank blob), `IdentityClaim` (unique index on `{type, hash}`, where hash = HMAC of the normalised phone/email/`accountNo+IFSC`, which enforces "one account per X"), `Payout`, `ReviewCase`, `Notification`.

```js
Payout { user, cycle, amountInr: 100, status: 'pending'|'processing'|'paid'|'failed',
         eligibleDay, providerRef, failureReason, idempotencyKey: `${user}:${cycle}` /* unique */ }
```

### 2.2 Changes to `Game` (infinite only)

| Field | Purpose |
|---|---|
| `date` | For `mode:'infinite'`, write `istDayKey()` instead of `todayKey()` (display only, no existing query depends on it). |
| `countedDay` | IST day of **completion**. A game started at 23:58 and finished at 00:02 counts for the new day. |
| `tierAtStart`, `tierAtCompletion` | Audit, plus hint enforcement across a tier change. |
| `hintRevealedAt` | Set by the new hint endpoint. |
| `pointsAwarded`, `scoredAt` | Idempotent scoring guard. |
| `clientIp`, `deviceId` | Anti-abuse signals. |

New index: `{ user: 1, mode: 1, countedDay: 1 }`.

---

## 3. How consistency is measured

Every consistency metric is derived from one binary fact per day: **did the player qualify?**

> A day **qualifies** when `activeMs ≥ targetMinutes` **and** `gamesCompleted ≥ targetGames`, using the targets snapshotted for that day.
> A day with no `InfiniteDay` document counts as **not qualified** (a miss).
> Tier 8 has no targets, but the PRD requires 7 qualifying days to leave it, so a Tier 8 day qualifies with **≥ 1 completed game** (config `tier8RequiresOneGame`). Otherwise an idle account would be promoted after a week.

Metrics built on top of it:

| # | Metric | Formula | Used for |
|---|---|---|---|
| A | Qualifying day | boolean above | base unit, +20 bonus |
| B | Qualifying streak | consecutive qualifying days in the current tier | promotion (≥ 7) |
| C | Rolling misses | count of `qualified:false` in the last 7 settled days in this tier | demotion (≥ 3), "demotion risk" at 2 |
| D | Tier-1 reward streak | consecutive qualifying days in Tier 1; any miss → 0 | ₹100 at 30 |
| E | Consistency % | `qualifyingDaysInTier / daysInTier` | profile display, analytics |
| F | Daily completion ratio | `0.5·min(1, active/targetMin) + 0.5·min(1, games/targetGames)` | progress ring on the card (partial credit, display only) |
| G | 30-day engagement | IST days with ≥1 completed game in the last 30 / 30 | PRD success metrics (D7/D30), not rules |

Only A–D drive rules. E–G are for display and analytics, so they can change without affecting anyone's tier.

### 3.1 Active time, server-side

The client sends a heartbeat every **15 s** while an Infinite game screen is **visible** and the user has given input within **60 s**. The server credits time as follows:

```
on heartbeat (and on every guess, which also counts as a heartbeat):
  day = istDayKey(now)
  doc = InfiniteDay(user, day)            // upsert, snapshot targets on insert
  eligible =
       visible && lastInputAgoMs ≤ 60 000
    && user has an in-progress infinite game (or one completed ≤ 60 s ago — the result screen)
    && last guess / game start on that game was ≤ 180 s ago   // server-side evidence of play
  gap = now − doc.lastHeartbeatAt
  credit = eligible && gap ≤ 45 000 ? gap : 0                // missed beats or a new session earn 0
  if doc.lastHeartbeatAt is on the previous IST day → credit = 0
  atomic: findOneAndUpdate({ _id, lastHeartbeatAt: <value read> },
                           { $inc: { activeMs: credit }, $set: { lastHeartbeatAt: now } })
  // if the conditional update loses a race with another tab → credit 0, no double-count
  re-evaluate `qualified`
```

Because credit is `now − lastHeartbeatAt` per user, two tabs sending heartbeats split the same wall-clock time and never add up to more than real time. The "guess in last 180 s" rule means a tab left open with a mouse jiggler stops earning after 3 minutes.

---

## 4. Scoring and ranking within a tier

**Per completed game** (credited once, when the game ends):

| Result | Points |
|---|---|
| Solve on guess *n* (1–6) | `10 + 2 × (6 − n)`, so 20 for guess 1 down to 10 for guess 6 |
| Loss | 0 (still counts toward `gamesCompleted` if `lossCountsTowardTarget`) |
| Abandoned | not counted (but see Q4) |
| Day qualifies | +20, once per day, the moment both targets are met (`bonusAwarded` guard) |

Points go to the player's **current** `TierMembership`, and to `InfiniteDay.pointsEarned` for the completion day.

**Order within a tier:** `score DESC, qualifyingDaysInTier DESC, scoreReachedAt ASC`.

**Rank of a player** (one indexed count, near real time):

```
rank = 1 + count({ tier: T, $or: [
  { score: { $gt: s } },
  { score: s, qualifyingDaysInTier: { $gt: q } },
  { score: s, qualifyingDaysInTier: q, scoreReachedAt: { $lt: t } } ] })
```

The list is `find({ tier }).sort(...).skip().limit()` on the same index. Rank is never stored, so any score change or tier move is reflected on the next read with no re-numbering job.

---

## 5. Daily reset job: promotion, demotion, rank on tier change

### 5.1 Trigger

`POST /api/cron/infinite-daily-reset`, authenticated with `CRON_SECRET` (existing `requireCronSecret`). Add a GH Actions schedule `30 18 * * *` (00:00 IST). The job settles `day = istDayKey(now) − 1` and is safe to run late, twice, or in pieces:

* Each call processes up to `batchSize` (default 500) memberships where `lastSettledDay < day`, then returns `{ done:false }`. The workflow calls it again until `done:true`.
* If a previous day was never settled (cron outage), the job settles days in order up to yesterday.
* Only tiers 1–7, plus Tier 8 members with an `InfiniteDay` yesterday, are scanned. Dormant Tier 8 accounts are never touched.

### 5.2 Steps for settling day D

1. **Snapshot cutoffs** (once per D, stored in `TierDaySnapshot`): for each tier T, `N_T` = members with `lastActiveDay ≥ D − 6`, `k = ceil(0.25 × N_T)`, `cutoff_T` = the (score, qualifyingDays, scoreReachedAt) tuple of the k-th ranked active member.
2. For each membership (where `lastSettledDay < D`):
   * `qualified` = the `InfiniteDay(D).qualified`, or `false` if there's no document.
   * Push `{D, qualified}` onto `window` (keep the last 7), and recompute `missesInWindow`.
   * If qualified: `qualifyingStreak++`, `qualifyingDaysInTier++` (`qualifyingDaysInTier` is incremented in real time when qualification happens. The job only confirms it.) Otherwise `qualifyingStreak = 0`.
   * Tier 1: `rewardStreak = qualified ? rewardStreak + 1 : 0`. At 30, create a `Payout` (see §6) and set `rewardStreak = 0`.
   * **Demote** if `tier ∈ 2..7` and `missesInWindow ≥ 3` → `tier + 1`. Tier 1 with ≥ 3 misses → Tier 2.
   * **Promote** if `tier ∈ 2..8`, `qualifyingStreak ≥ 7` and the player's tuple ranks at or above `cutoff_T`. At most one tier per night.
   * If the streak is ≥ 7 but the player isn't in the top 25%, they stay, and the streak keeps growing. They're promoted on the first night they're in the top 25% with the streak still ≥ 7.
   * Promotion needs 0 misses in the last 7 days, and demotion needs 3, so the two can't both apply on the same night.
   * Set `lastSettledDay = D`. The whole per-user update is one `findOneAndUpdate` conditioned on `lastSettledDay < D`, which makes re-runs no-ops.

### 5.3 What happens to rank on a tier change

On a move from tier A to tier B at time `t_job`:

```
oldRank       = rank(A) computed just before the move      // logged
carriedScore  = floor(0.20 × oldScore)
membership ← { tier: B, score: carriedScore, qualifyingDaysInTier: 0,
               scoreReachedAt: t_job, qualifyingStreak: 0, window: [], missesInWindow: 0,
               rewardStreak: 0, enteredTierAt: t_job, enteredTierDay: D + 1 }
rankAtEntry   = rank(B) computed just after the move       // logged, returned in notifications
```

Consequences:

* **In tier B**, the player is placed by their carried-in score. Because `qualifyingDaysInTier = 0` and `scoreReachedAt` is the latest time, they rank **below** every existing member with the same score, so an arriving player never jumps ahead of someone they tie with.
* **In tier A**, everyone who was ranked below the player moves up one place. No re-numbering is needed because rank is computed live.
* The 20% carry-in applies to **both** promotion and demotion (PRD §5.3 says "tier change"). A demoted player loses 80% of their score.
* The 7-day window and streak reset, so a newly promoted player is judged only against the new tier's targets from their first day there.

**Worked example: promotion.** Asha is in Tier 5 (Bronze) with score 1,450, 18 qualifying days, rank 12 of 60 active players. The cutoff is `ceil(0.25 × 60) = 15`, and she has a streak of 7.
At 00:00 IST she moves to Tier 4 (Silver) with score `floor(0.2 × 1450) = 290`. In Silver, 26 players have more than 290 and 1 has exactly 290 with 4 qualifying days, which beats her 0. Her `rankAtEntry` is **28**. In Bronze, the players ranked 13 to 60 each move up one place.

**Worked example: demotion.** Ravi is in Tier 3 (Gold) with score 900, and his window is `Q M Q M Q M` (3 misses). At the reset he moves to Tier 4 with score 180 and is ranked among Silver players by that score.

**Worked example: tie on entry.** Meera is promoted with a carried-in score of 200. Kiran is already in the tier with score 200. Meera ranks directly below Kiran. If Meera then solves one game (score 214), she passes Kiran on the next read.

---

## 6. Tier 1 reward (Phase 2)

* The `rewardStreak` counter lives on `TierMembership` and is maintained by the reset job (§5.2). Days before verification still count.
* When the counter reaches 30, the job creates a `Payout { cycle: rewardCycle + 1, status: 'pending' }` using the unique `idempotencyKey`. This enforces "max one per cycle" even if the job re-runs. `rewardCycle++`, `rewardStreak = 0`.
* The payout worker moves `pending` → `processing` only if verification is complete, there's no open `ReviewCase`, and there are no abuse flags. Otherwise the payout stays `pending` with a `blockedReason`.
* Provider callbacks (Razorpay/Cashfree payouts) arrive at `POST /api/webhooks/payouts` (signature-verified) → `paid` or `failed`.
* A bank-detail change sets `verification.bank = 'pending'`, which pauses that cycle's payout.

---

## 7. API contract

### 7.1 Changes to existing endpoints

| Endpoint | Change | Breaking? |
|---|---|---|
| `GET /game/infinite/current`, `POST /game/infinite/new` | `hint` is **removed** from in-progress infinite games (still returned once the game ends). Adds `hintsEnabled: bool` and `hintRevealed: bool`. If Q4 is accepted, `difficulty` is also hidden until the game ends. Records `tierAtStart`. | **Yes** for the frontend: hint display must call the new hint endpoint. |
| `POST /game/infinite/new` | Behaviour follows the answer to Q4 (abandoning after ≥ 1 guess may count as a loss). The response adds `today` (progress card). | Additive |
| `POST /game/infinite/guess` | Also counts as a heartbeat. On completion the game is scored idempotently (`scoredAt` guard) and the response adds a `tier` block (below). Games are never trusted from the client: the result is already computed server-side. | Additive |
| `GET /game/infinite/history` | Each game adds `pointsAwarded`, `countedDay`, `tierAtCompletion`. | Additive |
| `GET /auth/me` | Optional `infinite: { tier, tierName }` for a header badge. | Additive |
| `GET /leaderboard/daily`, `/weekly`, group boards | **No change.** | — |
| `GET /game/today`, `/guess`, `/history` (Daily) | **No change.** Daily stays on UTC. | — |

Additive block on `POST /game/infinite/guess` when the game finishes:

```json
{
  "result": [1, 1, 0, -1, 1],
  "game": { "...": "existing shape" },
  "tier": {
    "pointsAwarded": 16,
    "qualifyingBonusAwarded": 20,
    "score": 632,
    "rank": 14,
    "tierSize": 212,
    "today": { "activeMinutes": 41, "targetMinutes": 35, "gamesCompleted": 12, "targetGames": 12, "qualified": true }
  }
}
```

### 7.2 New endpoints: Phase 1

#### `GET /infinite/tiers`
Returns the tier table from `TierConfig`.
```json
{ "version": 3, "tiers": [ { "tier": 1, "name": "Diamond", "hintsEnabled": false, "minActiveMinutes": 60, "minGamesCompleted": 20, "rewardInr": 100 }, "..." ],
  "scoring": { "solveBase": 10, "perUnusedGuess": 2, "qualifyingDayBonus": 20 },
  "promotion": { "consecutiveDays": 7, "topPercent": 25 }, "demotion": { "misses": 3, "windowDays": 7 },
  "resetTimeIst": "00:00" }
```

#### `GET /infinite/me`
Tier status and today's progress, for the Infinite home screen.
```json
{
  "tier": 4, "tierName": "Silver", "hintsEnabled": false,
  "score": 632, "rank": 14, "tierSize": 212,
  "qualifyingDaysInTier": 9, "consistencyPercent": 82,
  "streak": { "current": 5, "neededForPromotion": 7, "daysToPromotion": 2 },
  "promotion": { "inTopPercent": true, "cutoffRank": 53 },
  "demotion": { "missesInWindow": 1, "limit": 3, "atRisk": false,
                "window": [ { "day": "2026-09-20", "qualified": true }, "..." ] },
  "today": { "day": "2026-09-26", "activeMinutes": 18, "targetMinutes": 25,
             "gamesCompleted": 6, "targetGames": 9, "qualified": false,
             "completionRatio": 0.69, "resetsAt": "2026-09-26T18:30:00.000Z" },
  "lastChange": { "fromTier": 5, "toTier": 4, "reason": "promotion", "oldRank": 12, "rankAtEntry": 28, "day": "2026-09-17" },
  "reward": null
}
```
`reward` is filled only for Tier 1 (same shape as `GET /rewards/me`). If the player has no membership yet, it returns Tier 8 defaults with `rank: null`.

#### `POST /infinite/activity/heartbeat`
Rate limit: 1 per 10 s per user. Extra calls return 200 with credit 0.
```json
// request
{ "gameId": "66f…", "visible": true, "lastInputAgoMs": 4200, "deviceId": "d-…" }
// response
{ "creditedMs": 15012, "today": { "activeMinutes": 19, "targetMinutes": 25, "gamesCompleted": 6, "targetGames": 9, "qualified": false } }
```

#### `POST /game/infinite/hint`
```json
// 200 (tiers 7–8)
{ "hint": "Hold and move" }
// 403 (tiers 1–6)
{ "message": "Hints are disabled in your tier", "code": "HINTS_DISABLED_FOR_TIER" }
```
The rule is checked against the player's tier **at request time**. A player promoted overnight into Tier 6 can't reveal a hint on a game they started in Tier 7.

#### `GET /leaderboard/infinite?tier=4&page=1&limit=20`
`tier` defaults to the caller's own tier. DB-side pagination.
```json
{
  "tier": 4, "tierName": "Silver",
  "leaderboard": [ { "rank": 1, "userId": "…", "username": "asha", "score": 2104, "qualifyingDaysInTier": 31, "streak": 12 }, "..." ],
  "me": { "rank": 14, "score": 632, "qualifyingDaysInTier": 9, "inThisTier": true },
  "promotionCutoffRank": 53,
  "pagination": { "page": 1, "limit": 20, "total": 212, "totalPages": 11 }
}
```
`me` is always included (the pinned row). If the caller is viewing another tier, it has `inThisTier: false` and `rank: null`.

#### `GET /infinite/tier-changes?page=1`
The caller's `TierChange` log, newest first.

#### `GET /notifications?unread=true` · `POST /notifications/read` `{ ids: [...] }`
Types: `promotion`, `demotion_risk` (2 misses), `demotion`, `reward_earned`, `payout_sent`, `payout_failed`, `verification_needed`. Each carries `data` (e.g. `{ fromTier, toTier, oldRank, rankAtEntry }`). Payout events also go out by email via the existing `utils/email.js`.

#### `POST /cron/infinite-daily-reset?batchSize=500` (CRON_SECRET)
```json
{ "day": "2026-09-25", "processed": 500, "promoted": 12, "demoted": 31, "payoutsCreated": 0, "done": false }
```

### 7.3 New endpoints: Phase 2 (verification and reward)

All return `403 { code: "TIER1_REQUIRED" }` unless the caller is in Tier 1 or has an open payout. The flow is resumable, and each step's state is in `GET /verification/status`.

| Method & path | Body | Notes |
|---|---|---|
| `GET /verification/status` | — | `{ mobile: {status, masked}, email: {status, masked}, bank: {status, maskedAccount, ifsc, nameMatch}, reviewCase: null \| {status} , nextStep }` |
| `POST /verification/mobile/otp` | `{ phone }` (E.164, +91 only if Q9 = India only) | Rate limit 3 per 15 min. 409 `IDENTITY_IN_USE` still sends the OTP but opens a review case (the PRD says to block the payout, not the tier). |
| `POST /verification/mobile/verify` | `{ phone, code }` | Creates an `IdentityClaim{type:'phone'}`. |
| `POST /verification/email/send` | — | Uses the account email. **Google sign-in accounts pass automatically** (Google has already verified the email). |
| `POST /verification/email/confirm` | `{ token }` | Same token-hash pattern as the existing reset-password flow. |
| `POST /verification/bank` | `{ accountHolderName, accountNumber, ifsc }` | Encrypted at rest (AES-256-GCM, key in env), returned only masked. Starts an async penny-drop; status goes `pending` → `verified` or `name_mismatch`. Resubmitting pauses the current cycle's payout. |
| `GET /rewards/me` | — | `{ day: 17, of: 30, verificationComplete, blockedReason, payouts: [{ cycle, amountInr, status, eligibleDay, paidAt }] }` |
| `POST /webhooks/payouts` | provider payload | Signature-verified, no JWT. |

### 7.4 Admin endpoints (need a new `requireAdmin` middleware)

`GET /admin/review-cases`, `POST /admin/review-cases/:id/resolve`, `GET /admin/payouts?status=`, `POST /admin/payouts/:id/retry`, `GET|PUT /admin/infinite/config`, `POST /admin/infinite/memberships/:userId/set-tier` (logged as `reason:'admin'`).

### 7.5 Error codes

`HINTS_DISABLED_FOR_TIER` 403 · `TIER1_REQUIRED` 403 · `IDENTITY_IN_USE` 409 · `OTP_INVALID` 400 · `OTP_RATE_LIMITED` 429 · `VERIFICATION_INCOMPLETE` 409 · `INVALID_TIER` 400.

---

## 8. Anti-abuse rules enforced on the server

1. Time is only credited by the heartbeat rules in §3.1, including the server-side evidence check (a guess within 180 s).
2. Hints are gated in `POST /game/infinite/hint` and are never in the payload for an in-progress game.
3. **Word prediction:** seed `infiniteAnswerOrder` with `HMAC(INFINITE_SEED_SECRET, userId)`. This reshuffles every existing user's order once, which is acceptable for casual mode.
4. **Cherry-picking:** hide `difficulty` until the game ends, and/or treat abandoning after ≥ 1 guess as a loss (Q4).
5. **Speed flags:** flag a game if it's solved in under 3 s per guess, or a user solves more than X% on guess 1–2 over 50 or more games. Flags create a `ReviewCase` that blocks payout (not tier).
6. **Linked accounts:** store `ip` and `deviceId` on game completion and heartbeats. Flag Tier 1 accounts that share a device or IP with another Tier 1–3 account.
7. **Rate limits:** heartbeat 1/10 s, guess 1/s, OTP 3/15 min, hint 1/game.
8. **Idempotency:** `Game.scoredAt`, `InfiniteDay.bonusAwarded`, `TierMembership.lastSettledDay`, `Payout.idempotencyKey`.

---

## 9. Open questions for product (in addition to PRD §11)

| # | Question | Default in this contract |
|---|---|---|
| Q1 | Does a no-show day count as a missed day? | Yes |
| Q2 | Tier 8 has no targets. What makes a Tier 8 day "qualifying" for promotion? | ≥ 1 completed game |
| Q3 | Top 25% of all members, or of active members? (Dormant accounts make it trivial otherwise.) | Active within 7 days |
| Q4 | Skipping is free and `difficulty` is visible up front, so players can cherry-pick easy words. Should we hide difficulty and/or count an abandon after ≥ 1 guess as a loss? | Hide difficulty until the end. Abandon after a guess = loss (0 pts, counts as completed). |
| Q5 | Does the 20% carry-in also apply on demotion? | Yes (PRD wording) |
| Q6 | Streak ≥ 7 but not top 25%: promote as soon as they reach the top 25% (streak intact), or restart the 7-day count? | Promote as soon as eligible |
| Q7 | Tier scores grow forever, so long-tenured players dominate the top-25% bar in the lower tiers. Add weekly decay? | No decay in Phase 1. Monitor. |
| Q8 | Daily mode resets at 05:30 IST (UTC) and Infinite at 00:00 IST. Is that acceptable? | Yes, Daily unchanged |
| Q9 | Should hint use in Tiers 7–8 reduce points? | No |
| Q10 | Admin tooling and who does manual review? | Minimal admin API only |

---

## 10. Rollout mapping

| Phase | Backend scope |
|---|---|
| 1 | `istDayKey`, Game field changes, `TierMembership`, `InfiniteDay`, `TierChange`, `TierConfig`; §7.1 changes; heartbeat, me, tiers, leaderboard, hint, tier-changes, notifications; reset job and workflow; anti-abuse 1–4, 7, 8. Backfill: none (everyone starts in Tier 8 on their first game, pending PRD Q8). |
| 2 | Verification, `IdentityClaim`, `ReviewCase`, `Payout` in test mode (provider sandbox), rewards/me, admin API, anti-abuse 5–6. |
| 3 | Switch payout provider to live after legal/TDS sign-off. Add PAN collection if TDS applies. |
