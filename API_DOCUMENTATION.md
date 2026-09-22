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

### Infinite mode (`/game/infinite/current`, `/game/infinite/new`, `/game/infinite/guess`, `/game/infinite/history`)
Same `game` shape and semantics as daily mode above (`mode: "infinite"` instead of `"daily"`), except **no `hint` field** — only `difficulty` (`"easy" | "medium" | "hard"`) is included, since infinite rounds are meant to stay unaided.

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
List every group the caller belongs to.
```json
{ "groups": [ { "name": "...", "inviteCode": "...", "owner": "...", "members": [...], "createdAt": "..." } ] }
```

### `POST /groups/:id/leave`
Removes the caller from the group. `{ "message": "Left group" }`.

### `GET /groups/:id/leaderboard`
Auth required, caller must be a member (`403` otherwise). Sorted by current streak, then total wins, descending — render top-to-bottom as-is, no client-side re-sort needed.
```json
{
  "group": { "id": "66f...", "name": "Office Wordlers", "inviteCode": "D87B4835" },
  "leaderboard": [
    { "userId": "66f...", "username": "Bob", "gamesPlayed": 12, "gamesWon": 10, "currentStreak": 4, "maxStreak": 6, "winRate": 83.3 },
    { "userId": "66f...", "username": "Alice", "gamesPlayed": 8, "gamesWon": 5, "currentStreak": 0, "maxStreak": 3, "winRate": 62.5 }
  ]
}
```
`winRate` is a percentage (0–100, one decimal place).

---

## Notes for the frontend build

- **CORS** is open (`cors()` with no restrictions) so the frontend can call this API from any origin during development. Tighten this (`origin: '<your frontend URL>'`) before production if needed — flag that to the backend if you deploy to a fixed domain.
- **Reset-password route**: make sure a `/reset-password/:token` page exists on the frontend and calls `POST /auth/reset-password/:token`, since that's the link users receive by email.
- **Auth persistence**: there's no refresh-token endpoint — the JWT is valid for 7 days flat; when it expires, `401` responses mean "log in again."
- **Dictionary size**: the accepted-guess word list is currently a few hundred common words (see backend `data/words.js`), not the full Wordle dictionary — expect some valid English words to be rejected with "Not a recognized word" until that list is expanded.
