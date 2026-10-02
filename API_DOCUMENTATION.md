# Wordle Backend API

Base URL: `http://localhost:8888/api` (change host/port per environment via `PORT` in the backend's `.env`)

All request/response bodies are JSON. Send `Content-Type: application/json` on every request with a body.

## Auth

Every endpoint except `signup` (and its `resend` / `verify-otp` / `verify/:token` steps), `login`, `forgot-password`, and `reset-password/:token` requires the header below (including `GET /sync`):

```
Authorization: Bearer <token>
```

`token` is returned by `signup` and `login`. It's a JWT that expires in 7 days (`JWT_EXPIRES_IN` in `.env`) — store it (e.g. localStorage / secure cookie) and send it on every subsequent request. On a `401`, discard it and send the user back to login.

### Error shape

Any failure returns:
```json
{ "message": "human-readable error message", "code": "MACHINE_READABLE_CODE" }
```
with an appropriate HTTP status (`400` validation, `401` auth, `402` not enough coins / payment failed, `403` forbidden, `404` not found, `409` conflict, `410` removed feature, `500` server error). `code` is present on most errors; branch on it, not on `message`.

---

## 1. Auth endpoints

### Signup (email verification)
Signup is two steps. The account is **only created once the email is verified**, so login, Google sign-in and existing accounts are unaffected.

1. `POST /auth/signup` emails the player a **6-digit code** and a **link** (`${FRONTEND_URL}/verify-signup/<token>`). Both expire in 15 minutes.
2. The player either types the code on the signup screen (`POST /auth/signup/verify-otp`) or clicks the link (`POST /auth/signup/verify/:token`). Either one creates the account and logs this device in. Once one is used, both stop working.

### `POST /auth/signup`
Request:
```json
{ "username": "Alice", "email": "alice@example.com", "password": "at-least-8-chars" }
```
Response `202` (no token yet; show the "enter your code" screen):
```json
{ "message": "We sent a verification code and link to your email", "email": "alice@example.com",
  "expiresInSeconds": 900, "resendAfterSeconds": 60 }
```
Errors: `400` missing fields / invalid email / password too short; `409 EMAIL_TAKEN` email already has an account; `429 SIGNUP_RATE_LIMITED` (with `retryAfterSeconds`) signed up again with this email less than a minute ago; `502 EMAIL_SEND_FAILED` the email couldn't be sent (try again).

Signing up again with the same email (after a minute) replaces the earlier username/password and sends a new code; the old code and link stop working.

### `POST /auth/signup/resend`
```json
{ "email": "alice@example.com" }
```
Response `200`: same body as signup. Sends a new code and link, and the old ones stop working. Errors: `404 SIGNUP_NOT_FOUND` nothing is waiting for this email (pending signups are dropped 24 h after the last email, so send the player back to signup); `429 SIGNUP_RATE_LIMITED` with `retryAfterSeconds`; `502 EMAIL_SEND_FAILED`.

### `POST /auth/signup/verify-otp`
```json
{ "email": "alice@example.com", "code": "482913", "deviceId": "..." }
```
Response `201`: `token` + `deviceId` + `user`, same shape as login (see the `user` example below). Errors: `400 SIGNUP_CODE_INVALID` wrong or expired code; `400 SIGNUP_CODE_ATTEMPTS` 5 wrong codes, so ask for a new one with `/signup/resend`; `409 EMAIL_TAKEN` the email got an account in the meantime (e.g. via Google), so send the player to login.

### `POST /auth/signup/verify/:token`
Called by the frontend's **`/verify-signup/:token`** page, the link in the email. It may be opened on a different device or browser than the one used to sign up.
```json
{ "deviceId": "..." }
```
Response `201`: `token` + `deviceId` + `user`, the same as `verify-otp`. Errors: `400 SIGNUP_LINK_INVALID` invalid, expired or already used (if the player already verified with the code, send them to login); `409 EMAIL_TAKEN`.

`user` shape (returned by verify-otp, verify/:token, login and Google):
```json
{
  "token": "eyJhbGciOi...",
  "deviceId": "...",
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

### `POST /auth/login`
```json
{ "email": "alice@example.com", "password": "...", "deviceId": "..." }
```
Response `200`: `token` + `deviceId` + `user` (shape above). Unchanged by signup verification: a signup that was never verified has no account, so login returns the usual `401`. `401` on bad credentials — also returned (same generic message, to avoid revealing which accounts are Google-only) if the account was created via Google sign-in and has no password set.

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
Auth required. Returns the current user's profile in the same `user` shape as above (includes live `stats` and `groups`). Use this to rehydrate session on app load. `user.signupLocation` is where the account was created (`{ "countryCode": "IN", "regionCode": "RJ", "region": "Rajasthan", "regionType": "State" }`), or `null` (no location known, or an account created before this was recorded). It's on every `user` object.

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
  "game": { "date": "2026-09-15", "status": "won", "attemptsUsed": 3, "attemptsRemaining": 3, "guesses": [...], "word": "carry", "difficulty": "medium", "hint": "Hold and move" },
  "coins": { "awarded": 10, "balance": 2350 }
}
```
`coins` is only on the guess that ends the game: `awarded` is 10 for a solve and 0 for a loss (see [section 7](#7-coins-wallet-store-paid-hints)).
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
- **`hint` while the game is in progress:** included when hints are free in the player's tier (Tiers 7–8, `hintCost: 0`) or once they've bought it. In Tiers 1–6 (`hintCost: 1000`) it's bought through `POST /game/infinite/hint`. It's included for every tier once the game ends.
- **`difficulty` is not included while the game is in progress.** It's included once the game ends.
- Extra fields: `id` (the round id — send it as `gameId` to the hint endpoint; also present on daily games), `hintCost` (coins for this tier's hint: `0` free, `1000` paid, `null` hints off), `hintRevealed`, `hintCoinsSpent`, `pointsAwarded`, `countedDay` (IST day the game counted toward), `tierAtCompletion`. `hintsEnabled` (= `hintCost === 0`) is deprecated and will be removed.
- `date` is the IST day the game started.
- **`today`, the progress card** (same shape as `today` in `GET /infinite/me`), is included in the response of **every** `POST /game/infinite/guess`, and of `GET /game/infinite/current` and `POST /game/infinite/new`. Use it to keep "Active time" up to date:
  ```json
  "today": { "day": "2026-09-26", "activeMinutes": 19, "targetMinutes": 25, "gamesCompleted": 6, "targetGames": 9,
             "qualified": false, "completionRatio": 0.69, "resetsAt": "2026-09-26T18:30:00.000Z" }
  ```
- `POST /game/infinite/guess`: when the guess ends the game, the response also has a `tier` block (its `today` is the same card as the top-level `today`):
  ```json
  { "result": [1,1,0,-1,1], "game": { "...": "..." },
    "tier": { "pointsAwarded": 16, "qualifyingBonusAwarded": 20, "score": 632, "rank": 14, "tierSize": 212,
              "promotion": null,
              "today": { "day": "2026-09-26", "activeMinutes": 41, "targetMinutes": 35, "gamesCompleted": 12,
                         "targetGames": 12, "qualified": true, "completionRatio": 1, "resetsAt": "2026-09-26T18:30:00.000Z" } },
    "today": { "...": "same as tier.today" },
    "coins": { "awarded": 10, "balance": 2350 } }
  ```
  Optional body field `deviceId` is stored for anti-abuse checks.
- **Instant promotion:** if this round makes today qualify **and** that completes the tier's day count (e.g. day 30 of 30 in Platinum), the player moves up **right away** instead of at midnight. `tier.promotion` is then `{ "fromTier": 2, "toTier": 1 }`, and `score` / `rank` / `tierSize` are already the new tier's. The same move shows as `lastChange` in `/infinite/me`, with the usual `promotion` notification. Demotions still happen at the nightly reset. It also works when the day qualifies through active time (a heartbeat or round start) rather than a finished round, but only a finished round's response carries `promotion`.
- **Active time** comes from these game calls: each round start and guess credits the time since the previous one, capped at 2 minutes per gap. Opening `/current` on a round that already exists credits nothing.
- `POST /game/infinite/new` (skip): a round abandoned **after at least one guess** counts as a completed loss (0 points). A round abandoned before any guess doesn't count.
- `POST /game/infinite/hint` `{ "gameId": "…", "expectedCost": 1000 }`: reveals the round's hint, one per round. Free tiers: `200` straight away. Paid tiers: `expectedCost` must equal the price shown on the confirm sheet, and the coins are debited and the hint revealed together. `200 { "hint": "Hold and move", "coinsSpent": 1000, "balance": 1340, "hintsUsed": 1, "hintsLeft": 0 }`. Asking again returns the hint with `coinsSpent: 0`. Errors: `402 INSUFFICIENT_COINS` (`balance`, `required`), `409 HINT_COST_CHANGED` (`hintCost`; nothing charged), `409 NOTHING_TO_REVEAL`, `403 HINTS_DISABLED_FOR_TIER` (`hintCost: null`, or no `expectedCost` sent), `400 NO_GAME_IN_PROGRESS`. Full contract: `docs/COINS_HINTS_CONTRACT.md` §4.2.

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

All authenticated. Full rules are in `docs/INFINITE_TIERS_BACKEND_CONTRACT.md`, and for coins, decay and the demotion penalty in `docs/COINS_HINTS_CONTRACT.md`. In short: 8 tiers (1 Diamond … 8 Stone). Every player starts in Tier 8 on their first completed Infinite game. A day **qualifies** when the player meets their tier's active-minutes and games-completed targets. Each qualifying day adds 1 to the tier's day counter (`stickDays`). When it reaches the tier's `daysToStick`, the player moves up (right away if a round completes it). A missed day resets the counter, and 3 misses in the tier's window move the player down (Tiers 1–7), keeping 20% of their points **minus 50**. A day with **no** Infinite game costs 5% of the player's points (at least 10). Each 30-day cycle in Diamond earns a **Diamond star**. Days run 00:00–23:59 **IST**.

### `GET /auth/me` (addition)
Now always returns `"infinite": { "tier": 4, "tierName": "Silver" }` for a header badge, and `"coinBalance": 2340` for the header coin chip (both top level, next to `user`). Before the player's first completed Infinite game `infinite` is `{ "tier": 8, "tierName": "Stone" }`.

### `GET /infinite/tiers`
**Public** (no login needed). Tier table and scoring rules.
```json
{ "version": 0,
  "tiers": [ { "tier": 1, "name": "Diamond", "hintCost": 1000, "hintsEnabled": false, "minActiveMinutes": 60,
               "minGamesCompleted": 20, "daysToStick": 30, "reward": { "type": "star" },
               "demotion": { "misses": 3, "windowDays": 30 } }, "..." ],
  "scoring": { "solveBase": 10, "perUnusedGuess": 2, "qualifyingDayBonus": 20 },
  "demotion": { "misses": 3, "windowDays": 7, "stickWindowMaxTier": 4 }, "carryInPercent": 20,
  "demotionPenalty": 50, "decay": { "rate": 0.05, "minPoints": 10 }, "coins": { "solveReward": 10 },
  "resetTimeIst": "00:00" }
```
`hintCost`: coins per hint (`0` free in Tiers 7–8, `1000` in Tiers 1–6, `null` hints off). `reward` is `{ "type": "star" }` for Diamond and `null` elsewhere. `rewardInr` (always `0`) and `hintsEnabled` are deprecated, kept one release for the installed app.
Each tier's `demotion` is the rule for that tier: the player is demoted on their `misses`-th missed day within the last `windowDays` settled days in the tier. In tiers 1–4 the window is the tier's commitment period (`daysToStick`): 3 misses in 30 days for Diamond and Platinum, 21 for Gold, 14 for Silver. Tiers 5–7 use 3 misses in 7 days. Tier 8 can't be demoted.

### `GET /infinite/me`
The player's tier status and today's progress card.
```json
{ "tier": 4, "tierName": "Silver", "hintCost": 1000,
  "score": 632, "rank": 14, "tierSize": 212, "qualifyingDaysInTier": 9, "consistencyPercent": 82,
  "counter": { "stickDays": 5, "daysToStick": 14, "daysLeft": 9, "resetsOnEntry": true },
  "demotion": { "missesInWindow": 1, "limit": 3, "windowDays": 14, "atRisk": false, "window": [ { "day": "2026-09-20", "qualified": true } ] },
  "today": { "day": "2026-09-26", "activeMinutes": 18, "targetMinutes": 25, "gamesCompleted": 6, "targetGames": 9,
             "qualified": false, "completionRatio": 0.69, "resetsAt": "2026-09-26T18:30:00.000Z" },
  "lastChange": { "fromTier": 5, "toTier": 4, "reason": "promotion", "oldScore": 1450, "oldRank": 12, "oldTierSize": 60,
                  "carriedScore": 290, "rankAtEntry": 28, "newTierSize": 212, "window": [ … ], "day": "2026-09-17", "createdAt": "…" },
  "completedCycles": [ { "cycle": 1, "day": "2026-08-30" } ], "stars": 1,
  "lastDecay": { "day": "2026-10-01", "points": -62 } }
```
Before the first completed game: Tier 8 defaults with `rank: null`. `completedCycles` / `stars` are the Diamond stars (one per completed 30-day cycle). `lastDecay` is the most recent inactivity decay, or `null`. `lastChange` also has `carriedPoints`, `penalty` and `entryPoints` (see tier-changes). `reward` was removed.

### `POST /infinite/activity/heartbeat` (deprecated)
**Don't call this in new code.** Active time now comes from game calls (see Infinite mode in section 2). The endpoint stays only for old app versions and will be removed. Old behaviour: send every **15 s** while an Infinite game screen is visible and the player has given input in the last 60 s. The server decides how much time to credit: it only counts time on a visible screen, with recent input, and a guess or game start in the last 3 minutes. Beats less than 10 s apart are ignored.
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
The player's promotions and demotions, newest first: `{ "changes": [ { "fromTier", "toTier", "reason", "oldScore", "oldRank", "oldTierSize", "carriedScore", "carriedPoints", "penalty", "entryPoints", "rankAtEntry", "newTierSize", "window", "day", "createdAt" } ], "pagination": { "page", "limit", "total", "totalPages" } }`. `carriedPoints` is 20% of `oldScore` (after that night's decay). `penalty` is the demotion penalty taken (`-50`, `0` on promotion). `entryPoints` = `carriedScore` is what the player entered the new tier with. `window` is the old tier's miss window (its last ≤`windowDays` days) (`{ day, qualified }`) at the moment of the move, e.g. the missed days behind a demotion. It's empty for moves logged before this field existed.

### `GET /notifications?unread=true&page=1` · `POST /notifications/read`
```json
{ "notifications": [ { "id": "…", "type": "promotion", "data": { "fromTier": 5, "toTier": 4, "oldRank": 12, "rankAtEntry": 28 }, "read": false, "createdAt": "…" } ],
  "unreadCount": 3, "pagination": { … } }
```
Types and their `data`:
- `promotion`, `demotion`: `fromTier`, `toTier`, `reason`, `oldScore`, `oldRank`, `oldTierSize`, `carriedScore`, `carriedPoints`, `penalty`, `entryPoints`, `rankAtEntry`, `newTierSize`.
- `demotion_risk` (one miss from demotion): `tier`, `missesInWindow`, `limit`, `windowDays`, `demotionPenalty`.
- `points_decayed` (inactivity decay, one per nightly settle): `points` (e.g. `-62`), `days`, `day` (latest), `tier`. "62 points lost".
- `coins_purchased`: `orderId`, `coins`, `balance`. "3,000 coins added".
- `payment_failed`: `orderId`, `coins`, `amountPaise`. "Payment didn't go through. You weren't charged."

Mark as read with `{ "ids": ["…"] }` (max 100), which returns `{ "updated": 2 }`. Notifications of removed features (`reward_earned`, `payout_*`, `verification_needed`) are never listed.

### `GET /infinite/score-events?cursor=&limit=20`
Every change to the player's tier points, newest first: `{ "items": [ { "id", "type", "points", "day", "tier", "gameId", "createdAt" } ], "nextCursor": "…" | null }`. `type`: `game`, `day_bonus`, `decay`, `carry_in`, `demotion_penalty`.

### `GET /rewards/me` — deprecated
Kept for one release for the installed app only. It returns the old shape with no money (`enabled: false`, `amountInr: 0`), with each completed Diamond cycle as a zero-amount "payout". New code: `stars` / `completedCycles` in `GET /infinite/me`.

---

## 7. Coins: wallet, store, paid hints

Full contract, flows and error codes: **`docs/COINS_HINTS_CONTRACT.md`**. Summary:

- **Earning:** +10 coins for every solved word, Daily and Infinite. It comes back as `coins` on the round-ending guess.
- **Spending:** the round's hint costs 1,000 coins in Tiers 1–6 and is free in Tiers 7–8 (`POST /game/infinite/hint`, section 2).
- **Buying:** 3,000 coins for ₹10, through Razorpay.

| Method & path | Notes |
|---|---|
| `GET /wallet` | `{ "balance": 2340, "updatedAt": "…" }` |
| `GET /wallet/transactions?cursor=&limit=20` | `{ "items": [ { "id", "type", "amount", "balanceAfter", "ref", "createdAt" } ], "nextCursor" }`. `type`: `earn_solve`, `purchase`, `hint_spend`, `refund`, `adjustment`. |
| `GET /store/coin-packs` | `{ "packs": [ { "packId": "coins_3000", "coins": 3000, "pricePaise": 1000, "currency": "INR" } ] }` |
| `POST /store/orders` `{ "packId" }` | Send `Idempotency-Key`. Returns `201` with the order and a `gateway` block (`provider`, `orderId`, `key`, `amountPaise`, `currency`) for Razorpay Checkout. `503 PAYMENTS_NOT_CONFIGURED` until the store is live. |
| `GET /store/orders/:orderId` | Order status (`created`, `paid`, `credited`, `failed`, `expired`) and `balance` |
| `POST /store/orders/:orderId/confirm` `{ "gatewayPaymentId", "signature" }` (or Checkout's `razorpay_payment_id` / `razorpay_order_id` / `razorpay_signature` unchanged) | `200 { "status": "credited", "coinsCredited": 3000, "balance": 3340 }`. `409 ALREADY_CREDITED` = success (the webhook got there first). `402 PAYMENT_FAILED` = bad signature. |
| `POST /webhooks/payments` | Razorpay → server, **not under `/api`**, no login, signature-checked |

**Removed:** mobile (WhatsApp/SMS), email-link and bank verification, and the ₹100 Diamond reward. Every `/verification/*` path answers `410 { "code": "GONE" }` for one release. `/rewards/me` still answers in its old shape, without money (see section 6).

---

## 8. Sync: only refetch what changed

### `GET /sync?since=<syncToken>`
Auth required. Tells the app which APIs have data that changed since the app last fetched them. Call it when a page opens, then call **only** the APIs marked `true` and use stored data for the rest.

```json
{
  "syncToken": "eyJ0diI6MSwicyI6eyJtZSI6WzEy…",
  "changed": {
    "me": false, "mine": true, "notifications": true, "infinite": false, "tierChanges": false,
    "wallet": false, "today": false, "tiers": false, "daily": true, "weekly": false, "infiniteBoard": false
  }
}
```

- **First call:** send no `since`. Everything comes back `true`.
- **After each sync:** mark the cached data of every `true` API as **stale**, save the new `syncToken`, and send it as `since` next time. Refetch a stale API when a page needs it; that can be right away for the current page, or later. Don't just drop a `true` flag for an API the current page doesn't use: the new token already counts it as fetched, so the change would be lost.
- **Keep the stale mark until a refetch succeeds.** A failed refetch leaves the data stale, so it's retried on the next page load.
- **One token per device and per user.** Clear the token (and the cached data) on logout or when another account logs in.
- A missing, broken or old-format token is treated as a first sync (everything `true`). It never returns an error.
- `Cache-Control: no-store`: the response is per user and must not be cached.

| Flag | API to refetch | Turns `true` when |
|---|---|---|
| `me` | `GET /auth/me` | Username changed, a daily game finished (stats), joined/left/created a group, tier changed (badge), coin balance changed (`coinBalance`) |
| `mine` | `GET /groups/mine` | This user **or another member** created, joined, left or renamed one of their groups |
| `notifications` | `GET /notifications` | A notification arrived or was marked read |
| `infinite` | `GET /infinite/me` (and `GET /infinite/score-events`) | Infinite play (score, new active-time minute, qualifying day), the nightly tier reset (IST midnight: decay, moves, stars) |
| `tierChanges` | `GET /infinite/tier-changes` | Promoted or demoted |
| `wallet` | `GET /wallet` (and `GET /wallet/transactions`) | Coins earned (a solve), bought, or spent (a hint) |
| `today` | `GET /game/today` | A guess in today's daily game (e.g. from another device), or a new daily word (UTC midnight) |
| `tiers` | `GET /infinite/tiers` | The tier config was edited |
| `daily` | `GET /leaderboard/daily` | Someone finished a daily game or renamed, or a new UTC day |
| `weekly` | `GET /leaderboard/weekly` | Same as `daily`, or a new week (Monday UTC) |
| `infiniteBoard` | `GET /leaderboard/infinite` | Any Infinite score or tier change (including decay), or a rename, or a new IST day |

- **The leaderboards (`daily`, `weekly`, `infiniteBoard`) turn `true` at most once every 60 s**, counted from the app's last fetch of that board. They change with every other player's game, so this caps a board at about one refresh a minute.
- **Safety net:** any API the app hasn't refetched for **15 minutes** comes back `true`, even if nothing is known to have changed.
- **Not covered by flags:** group leaderboards (`/groups/:id/leaderboard…`), history endpoints, `/game/infinite/current`, coin packs and orders, passkeys. Fetch these as before.

---

## 9. Signup location

When an account is **created**, by email signup or by a first "Continue with Google", the server saves the country and first-level region the request came from on the user, as `user.signupLocation`. Logins (email, or Google for an existing account) don't write anything. Nothing is needed from the app.

```json
"signupLocation": { "countryCode": "IN", "regionCode": "RJ", "region": "Rajasthan", "regionType": "State" }
```

- **Where it comes from:** the geolocation headers Vercel's edge adds after looking up the client's IP (`x-vercel-ip-country`, `x-vercel-ip-country-region`). There's no IP database and no third-party lookup, and the IP itself is never stored. Behind Cloudflare, set `TRUST_CLOUDFLARE_GEO=true` to use its visitor-location headers instead. Locally there are no headers, so the value is `null`.
- **Fields:**
  - `countryCode`: ISO 3166-1, e.g. `IN`.
  - `regionCode`: the region part of ISO 3166-2, e.g. `RJ`.
  - `region`: e.g. `Rajasthan`.
  - `regionType`: the local term. India, USA, Brazil, Germany, Mexico and Australia use `State`; Canada `Province`; France `Region`; UK `Country` (England); Japan `Prefecture`; China `Province` / `Autonomous region`; UAE `Emirate`.
- **Coverage:** region names are built in for those 12 countries (`utils/regions.js`). Other countries keep `regionCode` with `region: null`.
- **Email signup** uses the location of the signup form request, even if the emailed link is opened somewhere else.
- **Linking Google** to an existing email account isn't a signup, so it adds no location.
- **Accounts created before this** have `signupLocation: null`. Where they signed up is unknown, because IPs were never stored. `scripts/migrate-signup-location.js` sets the field explicitly on them, in place.

### `GET /analytics/signup-locations?from=2026-09-01&to=2026-10-02`
Server-to-server: `Authorization: Bearer $CRON_SECRET` (no user JWT). Counts new accounts by country, then region. `from` / `to` are IST days, inclusive; the default is the last 30.
```json
{ "from": "2026-09-01", "to": "2026-10-02", "total": 15, "unknownLocation": 1,
  "countries": [
    { "countryCode": "IN", "country": "India", "regionTerm": "State", "count": 12,
      "regions": [ { "regionCode": "MH", "region": "Maharashtra", "regionType": "State", "count": 7 },
                   { "regionCode": "RJ", "region": "Rajasthan", "regionType": "State", "count": 5 } ] },
    { "countryCode": "CA", "country": "Canada", "regionTerm": "Province", "count": 2,
      "regions": [ { "regionCode": "ON", "region": "Ontario", "regionType": "Province", "count": 2 } ] } ] }
```
Sorted by count. `unknownLocation` counts accounts with no location. `400 INVALID_RANGE` if `from` is after `to`.

---

## Notes for the frontend build

- **Timing headers (for diagnosing slow requests):** every response has `Server-Timing: app;dur=<ms>, db-wait;dur=<ms>`. That's the backend's own handling time, and the part of it spent waiting for the database connection. The first request a new server instance handles (a cold start) also has `boot;dur=<ms>` and `db-connect;dur=<ms>`, plus `X-Cold-Start: 1`. Both headers are readable from JS (`response.headers.get('server-timing')`). `GET /health/db` returns the same breakdown as JSON under `timing`, plus DNS and ping times.

- **CORS** is open (`cors()` with no restrictions) so the frontend can call this API from any origin during development. Tighten this (`origin: '<your frontend URL>'`) before production if needed — flag that to the backend if you deploy to a fixed domain.
- **Reset-password route**: make sure a `/reset-password/:token` page exists on the frontend and calls `POST /auth/reset-password/:token`, since that's the link users receive by email.
- **Verify-signup route**: make sure a `/verify-signup/:token` page exists on the frontend and calls `POST /auth/signup/verify/:token` with the device's `deviceId`, since that's the link in the signup email. On `201`, store the token and treat the player as logged in.
- **Auth persistence**: there's no refresh-token endpoint — the JWT is valid for 7 days flat; when it expires, `401` responses mean "log in again."
- **Dictionary size**: the accepted-guess word list is currently a few hundred common words (see backend `data/words.js`), not the full Wordle dictionary — expect some valid English words to be rejected with "Not a recognized word" until that list is expanded.
