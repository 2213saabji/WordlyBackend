# Wordle Backend API

Base URL: `http://localhost:8888/api` (change host/port per environment via `PORT` in the backend's `.env`)

All request/response bodies are JSON. Send `Content-Type: application/json` on every request with a body.

## Auth

Every endpoint except `signup`, `login`, `forgot-password`, and `reset-password/:token` requires:

```
Authorization: Bearer <token>
```

`token` is returned by `signup` and `login`. It's a JWT that expires in 7 days (`JWT_EXPIRES_IN` in `.env`) — store it (e.g. localStorage / secure cookie) and send it on every subsequent request. On a `401`, discard it and send the user back to login.

### Error shape

Any failure returns:
```json
{ "message": "human-readable error message" }
```
with an appropriate HTTP status (`400` validation, `401` auth, `403` forbidden, `404` not found, `409` conflict, `500` server error).

---

## 1. Auth endpoints

### `POST /auth/signup`
Create an account.

Request:
```json
{ "username": "Alice", "email": "alice@example.com", "password": "at-least-8-chars" }
```
Response `201`:
```json
{
  "token": "eyJhbGciOi...",
  "user": {
    "id": "66f...",
    "username": "Alice",
    "email": "alice@example.com",
    "stats": {
      "gamesPlayed": 0, "gamesWon": 0,
      "currentStreak": 0, "maxStreak": 0,
      "lastPlayedDate": null, "lastWinDate": null
    },
    "groups": []
  }
}
```
Errors: `400` missing fields / invalid email / password too short, `409` email already registered.

### `POST /auth/login`
```json
{ "email": "alice@example.com", "password": "...", "deviceId": "..." }
```
Response `200`: same shape as signup (`token` + `deviceId` + `user`). `401` on bad credentials — also returned (same generic message, to avoid revealing which accounts are Google-only) if the account was created via Google sign-in and has no password set.

### `POST /auth/google`
Signs the user in with a Google ID token instead of a password. Use this after the frontend runs Google Identity Services / Google Sign-In and receives a credential — send that credential here as `idToken`, don't try to validate it client-side.
```json
{ "idToken": "<Google ID token / credential from the frontend>", "deviceId": "..." }
```
Response `200`: same shape as `/auth/login` (`token` + `deviceId` + `user`).
- First sign-in with a given Google account creates a new user (no password set — `passwordHash` stays unset until/unless the user later sets one, e.g. via forgot-password).
- If the Google account's email already matches an existing email/password account, that account is linked (its `googleId` is set) instead of creating a duplicate — the user can then sign in with either method.
- The backend verifies `idToken` against Google's servers (audience = `GOOGLE_CLIENT_ID` in `.env`) — it never trusts a bare email/name from the frontend.

Errors: `400` missing `idToken`/`deviceId`; `401` invalid/expired/unverified-email Google credential; `500` if `GOOGLE_CLIENT_ID` isn't configured on the backend.

### `GET /auth/me`
Auth required. Returns the current user's profile in the same `user` shape as above (includes live `stats` and `groups`). Use this to rehydrate session on app load.

### `PATCH /auth/username`
Auth required. Updates the caller's display name.
```json
{ "username": "NewName" }
```
Response `200`: the updated `user` object, same shape as signup/login. `400` if `username` is missing, blank, or outside 2–30 characters after trimming. Usernames are not unique — no `409` for this endpoint.

### `POST /auth/forgot-password`
```json
{ "email": "alice@example.com" }
```
Response `200` — **always the same message**, whether or not the email exists (prevents account enumeration):
```json
{ "message": "If an account with that email exists, a password reset link has been sent." }
```
If the account exists, an email is sent with a link to `${FRONTEND_URL}/reset-password/<token>`. **The frontend must have a route at `/reset-password/:token`** that collects a new password and calls the endpoint below.

### `POST /auth/reset-password/:token`
`:token` is the raw token from the emailed link (path param, not a header).
```json
{ "password": "new-password-at-least-8-chars" }
```
Response `200`: `{ "message": "Password has been reset successfully" }`. `400` if the token is invalid/expired (tokens expire after 15 minutes) — send the user back to "forgot password" in that case.

---

## 2. Game endpoints

Wordle rules: **5-letter word, 6 attempts**, one shared word per calendar day (UTC) for all users — like the original Wordle. There's no "create game" call; a game is implicitly created the first time a user hits `/game/today` or submits a guess on a given day.

### `GET /game/today`
Returns (or lazily creates) the caller's game for today.
```json
{
  "game": {
    "date": "2026-09-15",
    "status": "in-progress",
    "attemptsUsed": 2,
    "attemptsRemaining": 4,
    "guesses": [
      { "guess": "candy", "result": [1, 1, 0, 0, 1] },
      { "guess": "marry", "result": [0, 1, 1, 1, 1] }
    ],
    "difficulty": "medium",
    "hint": "Elegance of movement"
  }
}
```
- `status` is one of `"in-progress" | "won" | "lost"`.
- `word` is **omitted** while `status` is `"in-progress"` (don't leak the answer) and included once the game is finished.
- `difficulty` is `"easy" | "medium" | "hard"`, derived from the answer word — always present, safe to show even mid-game (doesn't leak the word).
- `hint` is a short clue for the day's word (also safe to show mid-game). Same fields are present on every daily `game` object returned by `/game/today`, `/game/guess`, and `/game/history`.
- `guesses[].result` is a per-letter array, index-aligned with the letters of `guess`. Each value is:
  - `1` → letter is correct **and** in the right position
  - `-1` → letter is in the word but in the **wrong** position
  - `0` → letter is not in the word (or all its copies were already matched — see note on duplicate letters below)

### `POST /game/guess`
```json
{ "guess": "carry" }
```
Response `200`:
```json
{
  "result": [1, 1, 1, 1, 1],
  "game": { "date": "2026-09-15", "status": "won", "attemptsUsed": 3, "attemptsRemaining": 3, "guesses": [...], "word": "carry", "difficulty": "medium", "hint": "Hold and move" }
}
```
Errors:
- `400` — guess isn't exactly 5 letters, isn't alphabetic, or isn't a recognized dictionary word (`{ "message": "Not a recognized word" }`) — show this inline like real Wordle's "not in word list" toast, don't consume an attempt on the client.
- `400` — game already finished today (`game` is included in the error body so the UI can sync state), or no attempts left.

**Duplicate-letter handling:** this follows real Wordle behavior. E.g. target `CARRY`, guess `MARRY` → `[0,1,1,1,1]` (only as many `R`s get credited as actually appear in the target, matched positions first). Render this like the standard Wordle board/keyboard coloring — you don't need extra client-side logic for duplicates, the server already resolves it correctly.

### `GET /game/history`
Returns up to the last 30 days of the caller's games, newest first, same shape as a single `game` object above (each includes `word` since they're all finished).
```json
{ "games": [ { "date": "...", "status": "won", ... }, ... ] }
```

### Infinite mode (`/game/infinite/current`, `/game/infinite/new`, `/game/infinite/guess`, `/game/infinite/hint`, `/game/infinite/history`)
Same `game` shape and semantics as daily mode above (`mode: "infinite"` instead of `"daily"`), with these differences for the tier leaderboard (see [section 6](#6-infinite-tier-leaderboard)):
- **`hint` while the game is in progress:** included in Tiers 7–8 (same as today), and **not included in Tiers 1–6**. It's included for every tier once the game ends.
- **`difficulty` is not included while the game is in progress.** It's included once the game ends.
- Extra fields: `id` (the round id — send it as `gameId` in heartbeats; also present on daily games), `hintsEnabled` (the player's current tier allows hints), `hintRevealed`, `pointsAwarded`, `countedDay` (IST day the game counted toward), `tierAtCompletion`.
- `date` is the IST day the game started.
- `POST /game/infinite/guess`: when the guess ends the game, the response also has a `tier` block:
  ```json
  { "result": [1,1,0,-1,1], "game": { "...": "..." },
    "tier": { "pointsAwarded": 16, "qualifyingBonusAwarded": 20, "score": 632, "rank": 14, "tierSize": 212,
              "today": { "day": "2026-09-26", "activeMinutes": 41, "targetMinutes": 35, "gamesCompleted": 12,
                         "targetGames": 12, "qualified": true, "completionRatio": 1, "resetsAt": "2026-09-26T18:30:00.000Z" } } }
  ```
  Optional body field `deviceId` is stored for anti-abuse checks.
- `POST /game/infinite/new` (skip): a round abandoned **after at least one guess** counts as a completed loss (0 points). A round abandoned before any guess doesn't count. The response adds `today` (same shape as above).
- `POST /game/infinite/hint`: `200 { "hint": "..." }` in Tiers 7–8. `403 { "message": "Hints are disabled in your tier", "code": "HINTS_DISABLED_FOR_TIER" }` in Tiers 1–6. `400` if no game is in progress.

### How stats update
After a game finishes (win or loss), `user.stats` changes automatically — refetch `/auth/me` (or use the `user` object returned by the next login) to get fresh values:
- `gamesPlayed` +1 on any finish.
- `gamesWon` +1 on a win.
- `currentStreak`: on a win, +1 if the user's last win was exactly the previous calendar day, otherwise resets to 1; on a loss, resets to 0.
- `maxStreak`: running max of `currentStreak`.

---

## 3. Group endpoints

### `POST /groups`
Create a group. Caller becomes owner and first member.
```json
{ "name": "Office Wordlers" }
```
Response `201`:
```json
{
  "group": {
    "_id": "66f...", "name": "Office Wordlers", "inviteCode": "D87B4835",
    "owner": "66f...", "members": ["66f..."], "createdAt": "...", "updatedAt": "..."
  }
}
```
Show `inviteCode` prominently — it's what other users type in to join.

### `POST /groups/join/:code`
`:code` is the invite code (case-insensitive). No body.
Response `200`: the updated `group` object. `404` invalid code, `409` already a member.

### `GET /groups/mine`
List every group the caller belongs to, newest first. **Paginated** — same `page`/`limit` params and clamping behavior as the leaderboard endpoints (see [Leaderboard pagination](#leaderboard-pagination)).
```
GET /groups/mine?page=1&limit=20
```
```json
{
  "groups": [ { "name": "...", "inviteCode": "...", "owner": "...", "members": [...], "createdAt": "..." } ],
  "pagination": { "page": 1, "limit": 20, "total": 7, "totalPages": 1 }
}
```

### `PATCH /groups/:id`
Renames a group. **Owner only.**
```json
{ "name": "New Group Name" }
```
Response `200`: the updated `group` object, same shape as `POST /groups`. `400` if `name` is missing or blank after trimming; `404` if the group doesn't exist; `403` if the caller is a member but not the owner (or not a member at all).

### `POST /groups/:id/leave`
Removes the caller from the group. `{ "message": "Left group" }`.

### `GET /groups/:id/leaderboard`
Auth required, caller must be a member (`403` otherwise). Sorted by current streak, then total wins, descending — render top-to-bottom as-is, no client-side re-sort needed. **Paginated** — see below.
```
GET /groups/66f.../leaderboard?page=1&limit=20
```
```json
{
  "group": { "id": "66f...", "name": "Office Wordlers", "inviteCode": "D87B4835" },
  "leaderboard": [
    { "rank": 1, "userId": "66f...", "username": "Bob", "gamesPlayed": 12, "gamesWon": 10, "currentStreak": 4, "maxStreak": 6, "winRate": 83.3 },
    { "rank": 2, "userId": "66f...", "username": "Alice", "gamesPlayed": 8, "gamesWon": 5, "currentStreak": 0, "maxStreak": 3, "winRate": 62.5 }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 34, "totalPages": 2 }
}
```
`winRate` is a percentage (0–100, one decimal place).

### `GET /groups/:id/leaderboard/daily`
Auth required, caller must be a member. Ranks only members who have **finished** today's daily game (won or lost) — members still in-progress or who haven't played today don't appear. Sorted by win first, then fewer attempts, then faster time. **Paginated**, plus the caller's own entry is always included via `me` regardless of pagination (see below). Optional `?date=YYYY-MM-DD` (defaults to today, UTC).
```
GET /groups/66f.../leaderboard/daily?page=1&limit=20
```
```json
{
  "group": { "id": "66f...", "name": "Office Wordlers" },
  "date": "2026-09-24",
  "leaderboard": [
    { "rank": 1, "userId": "66f...", "username": "Bob", "status": "won", "attemptsUsed": 3, "timeTakenMs": 45000 }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 34, "totalPages": 2 },
  "me": { "rank": 27, "userId": "66f...", "username": "You", "status": "won", "attemptsUsed": 5, "timeTakenMs": 120000 }
}
```
- `me` is the caller's own ranked entry — **always present if they finished today's game**, even when their rank falls on a different page than the one requested. This is what lets the frontend show "you're #27" without a separate lookup or paging through everyone ahead of them.
- `me` is `null` if the caller hasn't finished today's game yet (in-progress or not started) — they simply aren't ranked yet.

### `GET /groups/:id/leaderboard/weekly`
Same as daily, but aggregated across the Mon–Sun week containing the reference date (`?date=` optional, defaults to today). Sorted by most wins, then fewer average attempts, then faster average time. **Paginated** the same way as above — no `me` field.
```json
{
  "group": { "id": "66f...", "name": "Office Wordlers" },
  "week": { "start": "2026-09-21", "end": "2026-09-27" },
  "leaderboard": [
    { "rank": 1, "userId": "66f...", "username": "Bob", "gamesPlayed": 5, "gamesWon": 5, "avgAttempts": 3.4, "avgTimeMs": 52000 }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 34, "totalPages": 2 }
}
```

### Leaderboard pagination
All three endpoints above accept the same optional query params:
- `page` — 1-indexed, defaults to `1`. Out-of-range values are clamped to the last valid page rather than returning an empty result or an error.
- `limit` — page size, defaults to `20`, capped at `100`. Invalid or missing values fall back to the default.

---

## 4. Global leaderboard endpoints

Same ranking logic as the group daily/weekly leaderboards above, but across **every** daily player, not scoped to a group. Auth required (any authenticated user, no membership check).

### `GET /leaderboard/daily`
Ranks everyone who finished today's daily game (won or lost). **Paginated** — see below. Optional `?date=YYYY-MM-DD` (defaults to today, UTC).
```
GET /api/leaderboard/daily?page=1&limit=20
```
```json
{
  "date": "2026-09-24",
  "leaderboard": [
    { "rank": 1, "userId": "66f...", "username": "Bob", "status": "won", "attemptsUsed": 3, "timeTakenMs": 45000 }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 512, "totalPages": 26 }
}
```
No `me` field here (unlike the group version) — this endpoint isn't scoped to a small enough set that "find yourself" is the primary use case.

### `GET /leaderboard/weekly`
Same as daily, aggregated Mon–Sun (the week containing `?date=`, defaults to today). **Paginated** the same way.
```json
{
  "week": { "start": "2026-09-21", "end": "2026-09-27" },
  "leaderboard": [
    { "rank": 1, "userId": "66f...", "username": "Bob", "gamesPlayed": 5, "gamesWon": 5, "avgAttempts": 3.4, "avgTimeMs": 52000 }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 512, "totalPages": 26 }
}
```
Pagination rules (`page`, `limit`, clamping) are identical to the group leaderboard endpoints — see [Leaderboard pagination](#leaderboard-pagination) above.

---

## 5. Contact endpoint

### `POST /contact`
Public — **no auth required**, anyone can submit (logged in or not).
```json
{
  "category": "bug",
  "name": "Alice",
  "email": "alice@example.com",
  "message": "Found a bug in infinite mode..."
}
```
- `category` must be one of: `"bug" | "word-suggestion" | "account" | "groups" | "other"`.
- `name`, `email`, `message` are all required strings; `email` is validated as a basic email shape; `message` is capped at 4000 characters.

Response `201`:
```json
{ "message": "Thanks — we got your message." }
```
Errors: `400` on any missing/invalid field (see the message for which one).

**What happens server-side** (informational, not something the frontend needs to orchestrate): the submission is stored, and an immediate notification email goes to the support inbox. Separately, backend-only scheduled jobs compile a daily and a weekly digest of all stored submissions and email them out, clearing the week's data after the weekly digest sends. None of that requires anything from the frontend beyond this one `POST` call.

---

## 6. Infinite tier leaderboard

All authenticated. Full rules are in `docs/INFINITE_TIERS_BACKEND_CONTRACT.md`. In short: 8 tiers (1 Diamond … 8 Stone). Every player starts in Tier 8 on their first completed Infinite game. A day **qualifies** when the player meets their tier's active-minutes and games-completed targets. Each qualifying day adds 1 to the tier's day counter (`stickDays`). When it reaches the tier's `daysToStick`, the player moves up that night. A missed day resets the counter, and 3 misses in any 7 days moves the player down (Tiers 1–7). Days run 00:00–23:59 **IST**. Tier moves happen only at 00:00 IST.

### `GET /auth/me` (addition)
Now always returns `"infinite": { "tier": 4, "tierName": "Silver" }` for a header badge. Before the player's first completed Infinite game this is `{ "tier": 8, "tierName": "Stone" }`.

### `GET /infinite/tiers`
**Public** (no login needed). Tier table and scoring rules.
```json
{ "version": 0,
  "tiers": [ { "tier": 1, "name": "Diamond", "hintsEnabled": false, "minActiveMinutes": 60,
               "minGamesCompleted": 20, "daysToStick": 30, "rewardInr": 100 }, "..." ],
  "scoring": { "solveBase": 10, "perUnusedGuess": 2, "qualifyingDayBonus": 20 },
  "demotion": { "misses": 3, "windowDays": 7 }, "carryInPercent": 20, "resetTimeIst": "00:00" }
```

### `GET /infinite/me`
The player's tier status and today's progress card.
```json
{ "tier": 4, "tierName": "Silver", "hintsEnabled": false,
  "score": 632, "rank": 14, "tierSize": 212, "qualifyingDaysInTier": 9, "consistencyPercent": 82,
  "counter": { "stickDays": 5, "daysToStick": 14, "daysLeft": 9, "resetsOnEntry": true },
  "demotion": { "missesInWindow": 1, "limit": 3, "atRisk": false, "window": [ { "day": "2026-09-20", "qualified": true } ] },
  "today": { "day": "2026-09-26", "activeMinutes": 18, "targetMinutes": 25, "gamesCompleted": 6, "targetGames": 9,
             "qualified": false, "completionRatio": 0.69, "resetsAt": "2026-09-26T18:30:00.000Z" },
  "lastChange": { "fromTier": 5, "toTier": 4, "reason": "promotion", "oldScore": 1450, "oldRank": 12, "oldTierSize": 60,
                  "carriedScore": 290, "rankAtEntry": 28, "newTierSize": 212, "window": [ … ], "day": "2026-09-17", "createdAt": "…" },
  "completedCycles": [ { "cycle": 1, "day": "2026-08-30" } ],
  "reward": null }
```
Before the first completed game: Tier 8 defaults with `rank: null`. `reward` is filled only in Tier 1 (same shape as `GET /rewards/me`).

### `POST /infinite/activity/heartbeat`
Send every **15 s** while an Infinite game screen is visible and the player has given input in the last 60 s. The server decides how much time to credit: it only counts time on a visible screen, with recent input, and a guess or game start in the last 3 minutes. Beats less than 10 s apart are ignored.
```json
// request
{ "gameId": "66f…", "visible": true, "lastInputAgoMs": 4200, "deviceId": "d-…" }
// response
{ "creditedMs": 15012, "today": { "day": "2026-09-26", "activeMinutes": 19, "targetMinutes": 25, "gamesCompleted": 6, "targetGames": 9, "qualified": false } }
```
Every guess also counts as a heartbeat.

### `GET /leaderboard/infinite?tier=4&page=1&limit=20`
**Public** (no login needed). One tier's board. `tier` defaults to the caller's own, or 8 when signed out. Order: score, then qualifying days in tier, then who reached the score first.
```json
{ "tier": 4, "tierName": "Silver",
  "leaderboard": [ { "rank": 1, "userId": "…", "username": "asha", "score": 2104, "qualifyingDaysInTier": 31, "stickDays": 12 } ],
  "me": { "rank": 14, "score": 632, "qualifyingDaysInTier": 9, "stickDays": 5, "tier": 4, "inThisTier": true },
  "pagination": { "page": 1, "limit": 20, "total": 212, "totalPages": 11 } }
```
`me` is the pinned row: `null` when signed out; for a signed-in player viewing another tier it has `inThisTier: false` and `rank: null`. A present but invalid/expired token still gets `401`. `400 INVALID_TIER` if `tier` isn't 1–8.

### `GET /infinite/tier-changes?page=1`
The player's promotions and demotions, newest first: `{ "changes": [ { "fromTier", "toTier", "reason", "oldScore", "oldRank", "oldTierSize", "carriedScore", "rankAtEntry", "newTierSize", "window", "day", "createdAt" } ], "pagination": { "page", "limit", "total", "totalPages" } }`. `window` is the old tier's last ≤7 days (`{ day, qualified }`) at the moment of the move, e.g. the missed days behind a demotion. It's empty for moves logged before this field existed.

### `GET /notifications?unread=true&page=1` · `POST /notifications/read`
```json
{ "notifications": [ { "id": "…", "type": "promotion", "data": { "fromTier": 5, "toTier": 4, "oldRank": 12, "rankAtEntry": 28 }, "read": false, "createdAt": "…" } ],
  "unreadCount": 3, "pagination": { … } }
```
Types sent today and their `data`:
- `promotion`, `demotion`: `fromTier`, `toTier`, `reason`, `oldScore`, `oldRank`, `oldTierSize`, `carriedScore`, `rankAtEntry`, `newTierSize`.
- `demotion_risk` (2 misses in the window): `tier`, `missesInWindow`, `limit`.
- `reward_earned` (only when rewards are on): `cycle`, `amountInr`, `day`.
- `verification_needed` (on promotion to Tier 1, only when rewards are on): `tier`.

`payout_sent` and `payout_failed` are reserved and not sent yet. Mark as read with `{ "ids": ["…"] }` (max 100), which returns `{ "updated": 2 }`.

### `GET /rewards/me`
Tier 1 reward cycle: `{ "enabled": false, "inTier1": true, "day": 17, "of": 30, "amountInr": 100, "verificationComplete": false, "blockedReason": "verification_pending", "payouts": [ { "cycle", "amountInr", "status", "eligibleDay", "paidAt" } ] }`.
- `verificationComplete`: all three verification steps are `verified`.
- `blockedReason`: `"review_case"` (a detail is linked to another account, see section 7), `"verification_pending"` (a step isn't verified yet), or `null`.
- Rewards are off for now (`enabled: false`): the Tier 1 counter still cycles at 30, but no payout is created.

---

## 7. Tier 1 verification

Verification is only for the Diamond (Tier 1) ₹100 reward. It isn't part of login, signup or password reset. The player verifies three details, in this order: **mobile → email → bank**. The flow can be left and resumed at any time, because the server keeps each step's state.

**Who can call it:** signed-in players in Tier 1, or players with a payout that hasn't been paid yet. Anyone else gets `403 { "code": "TIER1_REQUIRED" }`. The one exception is `POST /verification/email/confirm`, which needs no login (see below).

**The status object.** `GET /verification/status` returns it, and so does every step endpoint below after it finishes. Re-render the verification screen from it each time.
```json
{
  "mobile": { "status": "verified", "masked": "+•••••••2671" },
  "email":  { "status": "pending", "masked": "as••@example.com", "method": "link" },
  "bank":   { "status": "not_started", "masked": null, "ifsc": null, "nameMatch": null },
  "reviewCase": null,
  "nextStep": "email",
  "complete": false
}
```

| Field | Values | Meaning |
|---|---|---|
| `mobile.status` | `not_started` · `pending` · `verified` | `pending` = a code was sent and is waiting to be entered |
| `email.status` | `not_started` · `pending` · `verified` | `pending` = a link was emailed and hasn't been clicked yet |
| `email.method` | `link` · `google` · `null` | `google` = passed automatically because the account signs in with Google |
| `bank.status` | `not_started` · `pending` · `verified` · `name_mismatch` | `pending` = submitted, waiting for the bank check. `name_mismatch` = the name didn't match the bank's records, so ask the player to re-enter it |
| `masked` | string or `null` | The only form in which a phone number, email or account number is ever returned |
| `reviewCase` | `{ "status": "open", "reason": "identity_in_use", "detail": "phone" \| "email" \| "bank" }` or `null` | A detail is already linked to another GuessWord account. The step still shows `verified` and the player keeps their tier, but payouts are held for manual review. Show a "your payout is on hold for review" message |
| `nextStep` | `mobile` · `email` · `bank` · `null` | The step to show next. `null` means nothing is needed from the player right now (all done, or the bank check is still running) |
| `complete` | boolean | All three steps are `verified` |

### Step 1 · Mobile number

> **Not live yet:** no SMS provider has been chosen, so `POST /verification/mobile/otp` currently returns `503 { "code": "SMS_PROVIDER_NOT_CONFIGURED" }`. Show "Mobile verification is coming soon" for that code. Everything else in this step is built, and starts working as soon as a provider is plugged in on the backend. The frontend won't need any changes then.

**`POST /verification/mobile/otp`** `{ "phone": "+14155552671" }` sends a 6-digit code by SMS.
- **Numbers from any country are accepted**, in international (E.164) format: `+`, country code, then the number. Spaces, dashes, dots and brackets are removed first, so `+1 (415) 555-2671` is fine. A number without the `+` country code gets `400 PHONE_INVALID`.
- The code expires in **10 minutes**, and the response includes `"expiresInSeconds": 600`. The step becomes `pending`.
- **Limit: 3 codes per 15 minutes.** The 4th gets `429 { "code": "OTP_RATE_LIMITED", "retryAfterSeconds": 540 }`.
- Requesting a code for a *different* number sets the step back to `pending` until the new number is confirmed.
- If the number is already verified, the response is `200` with `"message": "This number is already verified"`, and no SMS is sent.

**`POST /verification/mobile/verify`** `{ "phone": "+14155552671", "code": "123456" }` confirms the code.
- Send the same number the code was requested for. A code only works for that number.
- A wrong or expired code gets `400 { "code": "OTP_INVALID" }`. After **5 wrong tries** the code stops working, and the player has to request a new one.
- On success the step becomes `verified`.

### Step 2 · Email

The email address is always the one on the player's account. The player doesn't type it.

**`POST /verification/email/send`** (no body) emails a verification link.
- The link is **`https://www.guessword.games/verify-email/<token>`** and expires in **24 hours**. The response includes `"expiresInSeconds": 86400`, and the step becomes `pending`.
- Resending is allowed once a minute. Sooner gets `429 { "code": "EMAIL_RATE_LIMITED", "retryAfterSeconds": 42 }`. A resend makes the previous link stop working.
- If the email can't be sent: `502 { "code": "EMAIL_SEND_FAILED" }`. It's safe to retry straight away.
- **Google sign-in accounts skip this step.** Their email is marked `verified` (`method: "google"`) the first time status is loaded, and no email is sent.

**`POST /verification/email/confirm`** `{ "token": "<token from the link>" }` needs **no login**.
- The frontend's `/verify-email/:token` page should call it on load. The player may open the link on a device where they aren't signed in, which is why no login is needed.
- Success: `200 { "message": "Email verified", "email": { "status": "verified", "masked": "as••@example.com" } }`.
- Invalid, expired or already-used link: `400 { "code": "VERIFICATION_TOKEN_INVALID" }`. Offer a "send a new link" button, which needs the player to be signed in.

### Step 3 · Bank account

**`POST /verification/bank`** `{ "accountHolderName": "Asha Rao", "accountNumber": "123456789012", "ifsc": "HDFC0001234" }`
- **Validation (400):**
  - `BANK_NAME_INVALID`: the name must be 2–100 characters.
  - `BANK_ACCOUNT_INVALID`: the account number must be 9–18 digits (spaces are removed first).
  - `IFSC_INVALID`: the IFSC must be 11 characters, 4 letters then `0` then 6 letters or digits. It's case-insensitive.
- Details are stored encrypted. Only `masked` (`••••9012`) and the IFSC are ever returned.
- After submitting, the step is `pending` while the bank check (penny-drop) runs. It then becomes `verified`, or `name_mismatch` if the name doesn't match the bank's records.
- **Not live yet:** no penny-drop provider has been chosen, so a submitted account currently stays `pending`. `nextStep` is `null` at that point, so show "we're checking your bank details".
- **Resubmitting** (to change the account, or fix a name mismatch) restarts the step at `pending`. That holds the current cycle's payout until the new account is verified.

### Error codes (verification)

| Code | HTTP | When |
|---|---|---|
| `TIER1_REQUIRED` | 403 | Not in Tier 1 and no unpaid payout |
| `PHONE_INVALID` | 400 | Not an international (E.164) number |
| `OTP_RATE_LIMITED` | 429 | More than 3 codes in 15 minutes (`retryAfterSeconds` included) |
| `OTP_INVALID` | 400 | Wrong, expired or used code, or 5 wrong tries |
| `SMS_PROVIDER_NOT_CONFIGURED` | 503 | Mobile verification isn't live yet |
| `OTP_SEND_FAILED` | 502 | The SMS provider failed; retry |
| `EMAIL_RATE_LIMITED` | 429 | Link resent within a minute (`retryAfterSeconds` included) |
| `EMAIL_SEND_FAILED` | 502 | The email couldn't be sent; retry |
| `VERIFICATION_TOKEN_INVALID` | 400 | Bad, expired or already-used email link |
| `BANK_NAME_INVALID` · `BANK_ACCOUNT_INVALID` · `IFSC_INVALID` | 400 | Bank form validation |

---

## Notes for the frontend build

- **CORS** is open (`cors()` with no restrictions) so the frontend can call this API from any origin during development. Tighten this (`origin: '<your frontend URL>'`) before production if needed — flag that to the backend if you deploy to a fixed domain.
- **Reset-password route**: make sure a `/reset-password/:token` page exists on the frontend and calls `POST /auth/reset-password/:token`, since that's the link users receive by email.
- **Auth persistence**: there's no refresh-token endpoint — the JWT is valid for 7 days flat; when it expires, `401` responses mean "log in again."
- **Dictionary size**: the accepted-guess word list is currently a few hundred common words (see backend `data/words.js`), not the full Wordle dictionary — expect some valid English words to be rejected with "Not a recognized word" until that list is expanded.
