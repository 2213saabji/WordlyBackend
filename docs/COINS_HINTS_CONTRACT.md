# Coins, paid hints, decay — API contract and frontend changes

Contract v0.4 · 2 Oct 2026 · Implements PRD "GuessWord · Coins, paid hints, and removal of the ₹100 reward" Draft v0.2

This document says what changed in the backend for PRD v0.2, the exact HTTP contract, and what the
frontend has to build or remove. It supersedes §6 (Tier 1 reward), §7.3 (verification) and the reward
parts of `docs/INFINITE_TIERS_BACKEND_CONTRACT.md`. Everything else in that document still holds.

All paths are under `/api` unless shown otherwise. Authenticated routes use the existing
`Authorization: Bearer <jwt>`. Errors keep the existing shape `{ "message": "…", "code": "…" }`.
Coin amounts are integers. Money is in paise.

---

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| Hint | **The existing word clue** (e.g. "Hold and move") is the hint. It is not a letter reveal. One per round. Free in Tiers 7–8 (unchanged). **1,000 coins in Tiers 1–6.** This was the owner's decision on 2 Oct and overrides PRD §2.3's letter-reveal wording. |
| Coins earned | +10 per solved word, **Daily and Infinite** (PRD open question 1: yes). Credited once per game. Losses and abandons earn 0. Hinted solves earn the full 10 coins and full tier points (open question 2: no change). |
| Ledger | Every balance change is a `CoinTransaction` row written in the **same MongoDB transaction** as the `Wallet` balance. Balance = sum of the ledger. The balance can't go below 0. |
| Confirm before charge | `POST /game/infinite/hint` in a paid tier requires `expectedCost` equal to the server's price. Without one (an app from before paid hints), it answers the old `403 HINTS_DISABLED_FOR_TIER`. With a different one (the price changed between showing the sheet and tapping confirm), it answers `409 HINT_COST_CHANGED`. Either way nothing is charged. The amount charged is always the server's. |
| Existing players and the installed app | Nothing breaks for accounts created before v0.2, or for the app version already installed. Missing new fields read as defaults: `signupLocation: null`, balance 0, `lastDecay: null`. The live app gets compatible answers for one release: `rewardInr: 0` in `/infinite/tiers`, `GET /rewards/me` answering `200` with stars as zero-amount payouts, and `hintsEnabled`. See §4.3. Covered by `test/existingUsers.test.js`. |
| Payments | Razorpay Orders + Checkout. Coins are credited by the client's confirm call **or** the webhook, whichever arrives first, through one idempotent credit. |
| Decay | Each settled IST day with **no completed Infinite game** costs `max(10, floor(5% × points))`, floor 0. It's applied by the nightly settle, before that night's promotion or demotion. It applies in every tier, including Tier 8. |
| Decay start | `decay.effectiveFrom` (IST day, config). Earlier days are never decayed, so the first reset after release doesn't decay dormant players for their whole absence. **Set it to the release day.** |
| Demotion penalty | Demotion carries in `floor(20% × points after decay) − 50`, floor 0. Promotion is unchanged (20%). |
| Diamond cycle | Earns a Diamond star (`completedCycles`, `stars`). There's no cash, no payout record and no notification. |
| Removed | WhatsApp/SMS mobile verification, email-link verification for payouts, bank verification, penny drop, payouts, `rewardsEnabled`. The old endpoints answer **410 Gone** for one release. |
| Staged rollout | `hintCost: null` in a tier means hints are off (the v0.1 behaviour). That makes PRD §10 step 2 ("earn coins, no spending yet") a config change, not a release. |

### PRD contract → what was built

The PRD's API sketch was written without reference to the existing routes. Here is how each item was mapped.

| PRD v0.4 | Implemented as | Why |
|---|---|---|
| `GET /wallet`, `GET /wallet/transactions` | `GET /api/wallet`, `GET /api/wallet/transactions` | `/api` prefix |
| `GET /store/coin-packs`, `POST /store/orders`, `POST /store/orders/{id}/confirm` | Same, under `/api`. Plus **`GET /api/store/orders/{id}`** | Polling for the case where checkout closes before confirm gets through |
| `POST /webhooks/payments` | `POST /webhooks/payments` (**not** under `/api`) | Signature is checked on the raw body, before the JSON parser |
| `POST /games/{game_id}/hints` | `POST /api/game/infinite/hint` `{ gameId, expectedCost }` | The existing hint endpoint. One hint per round. |
| `POST /games/{game_id}/complete` | A `coins` block on the round-ending response of `POST /api/game/guess` and `POST /api/game/infinite/guess` | The server ends games on the final guess. There is no separate complete call. |
| `GET /me` | `GET /api/auth/me` | Existing endpoint |
| snake_case fields | camelCase | Codebase convention. `coins_awarded`→`coins.awarded`, `balance_after`→`balanceAfter`, `price_paise`→`pricePaise`, `next_cursor`→`nextCursor`, `hint_cost`→`hintCost`, `last_decay`→`lastDecay`, `carried_points`→`carriedPoints`, `entry_points`→`entryPoints`, `gateway_payment_id`→`gatewayPaymentId` |
| `{ "error": "CODE" }` | `{ "message": "…", "code": "CODE" }` | Existing error shape |
| Hint `{ position, letter }`, 2 per game, `HINT_LIMIT_REACHED` | `hint` is the clue string. One per round. Asking again returns it free. There is no `HINT_LIMIT_REACHED`. | Owner decision |
| `NOTHING_TO_REVEAL` | Kept: the word has no clue in `data/wordHints.js` | |

---

## 1. Data model

### New collections

| Model | Purpose | Key fields |
|---|---|---|
| `Wallet` | One per player. Cached balance. | `user` (unique), `balance` (≥ 0) |
| `CoinTransaction` | Append-only ledger | `user`, `type` (`earn_solve` \| `purchase` \| `hint_spend` \| `refund` \| `adjustment`), `amount` (±), `balanceAfter`, `ref`, `idempotencyKey` (**unique**: `earn_solve:<gameId>`, `purchase:<orderId>`, `hint:<gameId>`) |
| `CoinOrder` | A pack purchase | `orderId` (`GW-12345678`), `user`, `packId`, `coins`, `amountPaise`, `currency` (copied from the pack), `status` (`created` → `paid` → `credited`, or `failed` / `expired`), `provider`, `gatewayOrderId` (unique), `gatewayPaymentId`, `idempotencyKey`, `expiresAt`, `paidAt`, `creditedAt`, `creditedBy` (`confirm` \| `webhook`), plus once-only guards `receiptSentAt` and `failedNotifiedAt` |
| `ScoreEvent` | Every tier-points change, for display | `user`, `type` (`game` \| `day_bonus` \| `decay` \| `carry_in` \| `demotion_penalty`), `points` (±), `day`, `tier`, `gameId` |

### Changed

| Model | Change |
|---|---|
| `Game` | + `hintCoinsSpent` |
| `TierMembership` | + `lastDecay { day, points }`. `completedCycles` now means Diamond stars. |
| `TierChange` | + `carriedPoints`, `penalty` (≤ 0), `entryPoints`. `carriedScore` = `entryPoints`. |
| `Notification` | Types are now `promotion`, `demotion_risk`, `demotion`, `coins_purchased`, `payment_failed`, `points_decayed`. Older documents with removed types stay in the database and are **never listed**. |
| `SyncState` | `rewards` counter replaced by `wallet` |
| `TierConfig` | See §2 |

### Deleted

The models `Verification`, `IdentityClaim`, `ReviewCase` and `Payout` are deleted, along with their utilities, controllers and routes. The data is removed by `scripts/purge-verification-data.js` (see §7).

---

## 2. Config (`TierConfig`, no release needed)

```js
tiers[n].hintCost      // 1000 in tiers 1–6, 0 in 7–8. null = hints off in that tier.
tiers[n].cycleReward   // 'star' in Tier 1, null elsewhere (replaces rewardInr)
demotionPenalty: 50
decay: { rate: 0.05, minPoints: 10, effectiveFrom: '2026-10-03' }
coins: {
  solveReward: 10,
  packs: [{ packId: 'coins_3000', coins: 3000, pricePaise: 1000, currency: 'INR' }],
  orderExpiryMinutes: 30,
}
// removed: rewardInr, rewardsEnabled
```

`coins.packs` given in a `TierConfig` document replaces the whole default list. You can add a ₹50 pack
without a release by adding a second entry.

---

## 3. Rules

### 3.1 Earning
- `+coins.solveReward` (10) when the server ends a game as `won`, Daily or Infinite. It is credited once per game: a repeat or concurrent call gets `awarded: 0`.
- The round-ending guess response carries `coins: { awarded, balance }`. `awarded` is 0 for a loss.

### 3.2 Buying
1. `POST /store/orders` creates a `CoinOrder` and a Razorpay order. The app opens Razorpay Checkout with the returned `gateway` block.
2. Checkout success → the app calls `POST /store/orders/{orderId}/confirm` with Razorpay's `razorpay_payment_id` and `razorpay_signature`. The server verifies `HMAC_SHA256(gatewayOrderId|paymentId, key_secret)`.
3. In parallel, Razorpay calls `POST /webhooks/payments` (`payment.captured` / `order.paid`). The server verifies `X-Razorpay-Signature` against the raw body and checks the amount matches the order.
4. Whichever arrives first moves the order to `credited` and writes the `purchase` ledger entry in one transaction. The other finds it credited (confirm returns `409 ALREADY_CREDITED`, which the app treats as success).
5. After the credit: one `coins_purchased` notification and one receipt email to the account email.
6. `payment.failed` → order `failed`, one `payment_failed` notification, nothing credited. Checkout allows another attempt on the same order; a later capture still credits.
7. An unpaid order reads as `expired` after `orderExpiryMinutes`. A payment captured after that is **still credited** (the player was charged).

A bad signature on confirm returns `402 PAYMENT_FAILED` and leaves the order unchanged. It isn't proof
of anything, and a real payment still credits through the webhook.

### 3.3 Spending: the hint

| Tier `hintCost` | In-progress `game.hint` | `POST /game/infinite/hint` |
|---|---|---|
| `0` (Tiers 7–8) | Included from the start (unchanged) | Reveals it, charges nothing |
| `1000` (Tiers 1–6) | **Omitted** until bought | Requires `expectedCost: 1000`. Debit and reveal happen in one transaction. |
| `null` (hints off) | Omitted | `403 HINTS_DISABLED_FOR_TIER` |

- Price is the player's tier **at request time**.
- Once revealed, `game.hint` stays in the payload and `hintRevealed: true`. Calling again returns the hint with `coinsSpent: 0`.
- If the reveal can't happen (the round ended, or a concurrent request won), the transaction aborts and **nothing is deducted**.
- Every game includes its `hint` once it's finished (unchanged).

### 3.4 Inactivity decay (nightly settle)
For each settled IST day `D ≥ decay.effectiveFrom`, if the player completed no Infinite game that day:

```
lost  = min(points, max(decay.minPoints, floor(points × decay.rate)))   // 1,240 → 62
points -= lost
```

- A day that was played but missed its targets isn't decayed. It's only a miss toward demotion.
- Several idle days compound, one day at a time. A player who returns after a break is settled lazily on their first request.
- One `points_decayed` notification per settle, covering every idle day it applied.
- Tier 8 members with points > 0 are now scanned by the nightly job, so their decay runs even when they don't play.

### 3.5 Demotion penalty
On the night of a demotion, the order is: decay, then window, then demotion.

```
carriedPoints = floor(carryInPercent% × points after tonight's decay)   // 900 → 180
entryPoints   = max(0, carriedPoints − demotionPenalty)                  // 180 − 50 = 130
penalty       = entryPoints − carriedPoints                              // −50 (or less, never below what was carried)
```

Worked examples:
- **Gold 900, third miss on a day that was played:** 900 → 180 → **130** in Silver.
- **Gold 900, third miss on an idle day:** 900 − 45 = 855 → 171 → **121**.

Promotion: `entryPoints = carriedPoints`, `penalty = 0`.

---

## 4. API contract

### 4.1 Added

#### `GET /wallet`
```json
200 { "balance": 2340, "updatedAt": "2026-10-02T08:40:11.000Z" }
```
A player with no wallet yet: `{ "balance": 0, "updatedAt": null }`.

#### `GET /wallet/transactions?cursor=&limit=20`
`limit` defaults to 20, max 50. Newest first.
```json
200 { "items": [ { "id": "6703…", "type": "hint_spend", "amount": -1000, "balanceAfter": 1340,
                   "ref": { "gameId": "66f…", "tier": 4 }, "createdAt": "2026-10-02T08:40:11.000Z" } ],
      "nextCursor": "6702…" }
```
- `ref` by type:
  - `earn_solve`: `{ gameId, mode: "daily"|"infinite", tier }`
  - `purchase`: `{ orderId, packId }`
  - `hint_spend`: `{ gameId, tier }`
- `nextCursor: null` on the last page.
- `400 INVALID_CURSOR` for a malformed cursor.

#### `GET /store/coin-packs`
```json
200 { "packs": [ { "packId": "coins_3000", "coins": 3000, "pricePaise": 1000, "currency": "INR" } ] }
```

#### `POST /store/orders` `{ "packId": "coins_3000" }`
Send an `Idempotency-Key` header (a UUID per tap). A retry with the same key returns the same order (`200`) instead of creating a second one.
```json
201 { "orderId": "GW-24816093", "status": "created", "packId": "coins_3000", "coins": 3000,
      "amountPaise": 1000, "currency": "INR", "createdAt": "…", "expiresAt": "…", "paidAt": null, "creditedAt": null,
      "gateway": { "provider": "razorpay", "orderId": "order_Nx81…", "key": "rzp_live_…",
                   "amountPaise": 1000, "currency": "INR" } }
```
| Status | Code | When |
|---|---|---|
| 400 | `INVALID_PACK` | Unknown `packId` |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different pack |
| 503 | `PAYMENTS_NOT_CONFIGURED` | No gateway configured (store not open yet). Hide or disable buying. |
| 502 | `PAYMENT_PROVIDER_ERROR` | Razorpay refused or is unreachable. Retry. |

#### `GET /store/orders/{orderId}`
```json
200 { "orderId": "GW-24816093", "status": "credited", "packId": "coins_3000", "coins": 3000, "amountPaise": 1000,
      "currency": "INR", "createdAt": "…", "expiresAt": "…", "paidAt": "…", "creditedAt": "…", "balance": 3340 }
```
- `status`: `created` | `paid` | `credited` | `failed` | `expired`.
- `404 ORDER_NOT_FOUND` (including another player's order).

#### `POST /store/orders/{orderId}/confirm` `{ "gatewayPaymentId": "pay_Q1…", "signature": "…" }`
Checkout's handler response can also be sent unchanged: `{ "razorpay_payment_id", "razorpay_order_id", "razorpay_signature" }`. If `razorpay_order_id` is sent, it must match the order.
```json
200 { "status": "credited", "orderId": "GW-24816093", "coinsCredited": 3000, "balance": 3340 }
```
| Status | Code | When | App does |
|---|---|---|---|
| 409 | `ALREADY_CREDITED` (+ `coinsCredited`, `balance`) | The webhook got there first, or this is a retry | Treat as success |
| 400 | `INVALID_REQUEST` | `gatewayPaymentId` or `signature` missing | Bug in the app |
| 400 | `ORDER_MISMATCH` | `razorpay_order_id` sent and it isn't this order's | Bug in the app |
| 402 | `PAYMENT_FAILED` | Signature doesn't verify | "Payment didn't go through. You weren't charged." |
| 404 | `ORDER_NOT_FOUND` | | |
| 503 | `PAYMENTS_NOT_CONFIGURED` | | |

#### `POST /webhooks/payments` (gateway → server)
No session. Raw body. `X-Razorpay-Signature` required (`401` without a valid one).
- Handles `payment.captured`, `order.paid` and `payment.failed`.
- Any other valid event gets `200`.
- A captured amount that doesn't match the order is logged and **never credited**.

#### `GET /infinite/score-events?cursor=&limit=20`
Newest first. Days up to yesterday are settled (and decayed) before listing.
```json
200 { "items": [ { "id": "…", "type": "decay", "points": -62, "day": "2026-10-01", "tier": 4, "gameId": null, "createdAt": "…" },
                 { "id": "…", "type": "demotion_penalty", "points": -50, "day": "2026-09-26", "tier": 4, "gameId": null, "createdAt": "…" },
                 { "id": "…", "type": "game", "points": 16, "day": "2026-09-26", "tier": 3, "gameId": "66f…", "createdAt": "…" } ],
      "nextCursor": "…" }
```
- `type`: `game` | `day_bonus` | `decay` | `carry_in` | `demotion_penalty`.
- `carry_in` is recorded with the new tier.
- Recording starts with this release. There is no backfill.

### 4.2 Changed

#### `POST /game/infinite/hint` `{ "gameId": "66f…", "expectedCost": 1000 }`
`gameId` is optional. If sent, it must be the current round. `expectedCost` is required when the tier's `hintCost > 0`.
```json
200 { "hint": "Hold and move", "coinsSpent": 1000, "balance": 1340, "hintsUsed": 1, "hintsLeft": 0 }
```
| Status | Code | Body extras | When |
|---|---|---|---|
| 402 | `INSUFFICIENT_COINS` | `balance`, `required` | Balance under the cost |
| 409 | `HINT_COST_CHANGED` | `hintCost`, `balance` | `expectedCost` missing or not the current price. Nothing charged. |
| 409 | `NOTHING_TO_REVEAL` | | This word has no clue |
| 403 | `HINTS_DISABLED_FOR_TIER` | `hintCost`, `balance` (paid tier) | `hintCost: null` (hints off), or a paid tier with no `expectedCost` (an app from before paid hints) |
| 400 | `NO_GAME_IN_PROGRESS` | | No round, `gameId` mismatch, or the round ended |

Free tiers return the same `200` shape with `coinsSpent: 0`. A second call after a reveal returns `200` with `coinsSpent: 0`.

#### Infinite `game` object (`/game/infinite/current`, `/new`, `/guess`, `/history`)
```json
{ "...": "existing fields",
  "hint": "…",                // omitted mid-round when hintCost > 0 or null and not yet revealed
  "hintCost": 1000,           // NEW: 0 free · 1000 paid · null off
  "hintRevealed": false,
  "hintCoinsSpent": 0,        // NEW
  "hintsEnabled": false }     // DEPRECATED: hintCost === 0. Removed next release.
```

#### `POST /game/guess` and `POST /game/infinite/guess`: round-ending response
```json
{ "result": [1,1,1,1,1], "game": { "...": "…" }, "tier": { "...": "infinite only, unchanged" },
  "coins": { "awarded": 10, "balance": 2350 } }
```
- `coins` is present only on the response that ends the game.
- `awarded` is `0` for a loss, an abandon-as-loss, or a round a concurrent request already credited.

#### `GET /auth/me`
Adds `"coinBalance": 2340` at the top level, next to `user` and `infinite`. (No `mobile` fields ever existed on `user`.)

#### `GET /infinite/tiers`
```json
{ "tiers": [ { "tier": 1, "name": "Diamond", "hintCost": 1000, "hintsEnabled": false,
               "minActiveMinutes": 60, "minGamesCompleted": 20, "daysToStick": 30,
               "reward": { "type": "star" }, "demotion": { "misses": 3, "windowDays": 30 } },
             { "tier": 7, "name": "Iron", "hintCost": 0, "hintsEnabled": true, "reward": null, "...": "…" } ],
  "...": "scoring, demotion, carryInPercent, resetTimeIst unchanged",
  "demotionPenalty": 50,
  "decay": { "rate": 0.05, "minPoints": 10 },
  "coins": { "solveReward": 10 } }
```
`rewardInr` is **deprecated and always `0`** (so the installed app shows the star, never a ₹ amount). It's removed next release, along with `hintsEnabled`. New code uses `reward` and `hintCost`.

#### `GET /infinite/me`
- **Added:**
  - `hintCost`
  - `stars` (number of completed Diamond cycles)
  - `lastDecay` (`{ "day": "2026-10-01", "points": -62 }` or `null`)
- **Kept:** `completedCycles: [{ cycle, day }]`, which is now the source for star and cycle history (previously the app read these from `/rewards/me` payouts).
- **Removed:** `reward`.
- **Deprecated:** `hintsEnabled`.

#### `GET /infinite/tier-changes` (and `lastChange` in `/infinite/me`)
Each change adds `carriedPoints`, `penalty` and `entryPoints`. Moves logged before v0.2 report `carriedPoints = entryPoints = carriedScore` and `penalty = 0`.
```json
{ "fromTier": 3, "toTier": 4, "reason": "demotion", "oldScore": 900, "carriedPoints": 180, "penalty": -50,
  "entryPoints": 130, "carriedScore": 130, "rankAtEntry": 41, "...": "…" }
```

#### `GET /notifications`
| Type | `data` | Copy (PRD §6 row 10) |
|---|---|---|
| `coins_purchased` *(new)* | `orderId`, `coins`, `balance` | "3,000 coins added" → Coins |
| `payment_failed` *(new)* | `orderId`, `coins`, `amountPaise` | "Payment didn't go through. You weren't charged." → Coins |
| `points_decayed` *(new)* | `points` (e.g. `-62`), `days`, `day` (latest), `tier` | "62 points lost" (or "97 points lost over 2 days") → Infinite hub |
| `promotion`, `demotion` | adds `carriedPoints`, `penalty`, `entryPoints` | Demotion shows the penalty |
| `demotion_risk` | adds `demotionPenalty` | "…and 50 points" |

`reward_earned`, `payout_sent`, `payout_failed` and `verification_needed` are **no longer sent or listed**, and `unreadCount` excludes them.

#### `GET /sync`
The flag `rewards` is replaced by **`wallet`**. It turns true when the balance changed (solve, purchase, hint). Refetch `GET /wallet` and, if the Coins screen is open, `GET /wallet/transactions`. Every wallet change also turns `me` true, because of `coinBalance`. Score events are covered by `infinite`.

#### `POST /cron/infinite-daily-reset`
```json
{ "day": "…", "processed": 500, "promoted": 12, "demoted": 31, "decayed": 140, "pointsDecayed": 6120,
  "starsEarned": 1, "failed": 0, "done": false }
```
`payoutsCreated` is removed.

### 4.3 Removed: 410 Gone for one release, then deleted

`GET /verification/status` · `POST /verification/mobile/otp` · `POST /verification/mobile/verify` ·
`POST /verification/email/send` · `POST /verification/email/confirm` · `POST /verification/bank`, and anything else under `/api/verification` or `/api/rewards`.

All of these return `410 { "message": "This feature has been removed", "code": "GONE" }`. The installed app only calls them when its `MONEY_ENABLED` flag is on, and it's off.

**Exception: `GET /rewards/me` still answers `200` for one release.** The installed app's Diamond and Tier history screens call it without checking the money flag, and build Diamond stars from its `payouts`. It now returns:
```json
{ "enabled": false, "inTier1": true, "day": 4, "of": 30, "amountInr": 0, "verificationComplete": false,
  "blockedReason": null, "payouts": [ { "cycle": 1, "amountInr": 0, "status": "paid", "eligibleDay": "2026-08-01", "paidAt": null } ] }
```
Each completed cycle appears as a zero-amount "payout", which that app renders as a star. New code reads `stars` and `completedCycles` from `/infinite/me`.

`GET|POST /webhooks/whatsapp` is removed outright (404). Remove the webhook in the Meta app dashboard.

### 4.4 Error codes

| Code | HTTP | Endpoint |
|---|---|---|
| `INSUFFICIENT_COINS` | 402 | hint |
| `HINT_COST_CHANGED` | 409 | hint |
| `NOTHING_TO_REVEAL` | 409 | hint |
| `HINTS_DISABLED_FOR_TIER` | 403 | hint (`hintCost: null`) |
| `NO_GAME_IN_PROGRESS` | 400 | hint |
| `INVALID_PACK` | 400 | create order |
| `IDEMPOTENCY_KEY_REUSED` | 409 | create order |
| `PAYMENTS_NOT_CONFIGURED` | 503 | create order, confirm |
| `PAYMENT_PROVIDER_ERROR` | 502 | create order |
| `PAYMENT_FAILED` | 402 | confirm |
| `ALREADY_CREDITED` | 409 | confirm (success) |
| `ORDER_NOT_FOUND` | 404 | get order, confirm |
| `INVALID_CURSOR` | 400 | wallet transactions, score events |
| `GONE` | 410 | removed endpoints |

Removed codes: `TIER1_REQUIRED`, `PHONE_INVALID`, `OTP_*`, `SMS_PROVIDER_NOT_CONFIGURED`,
`WHATSAPP_RECIPIENT_NOT_ALLOWED`, `EMAIL_RATE_LIMITED`, `EMAIL_SEND_FAILED` (verification only; signup still uses it),
`VERIFICATION_TOKEN_INVALID`, `BANK_*`, `IFSC_INVALID`, `VERIFICATION_INCOMPLETE`, `IDENTITY_IN_USE`.

### 4.5 Anti-abuse (PRD §7)

| Rule | How |
|---|---|
| Server-side only | Clients never send an amount. `expectedCost` is a guard and is never charged. |
| Balance ≥ 0 | Debits are a conditional update on `balance ≥ cost`, inside the transaction |
| Verified credit only | Gateway signature checked on confirm and webhook. Amount checked on webhook. |
| One credit per order, solve, hint | Unique `idempotencyKey` on the ledger, plus conditional order status |
| Abnormal solve rates | **Not built yet.** The ledger (`earn_solve`) and `ScoreEvent` (`game`) hold the data. See §8. |

---

## 5. Frontend changes

File references are to `WordlyFrontend` as of 2 Oct.

### 5.1 API layer and types

- **`lib/api/client.ts`:** let `apiFetch` take extra `headers`, for `Idempotency-Key`. Its one automatic 5xx retry is then safe for `POST /store/orders`. Hint and confirm are idempotent on their own.
- **New `lib/api/wallet.ts`:** `getWallet()`, `getWalletTransactions(cursor?)`.
- **New `lib/api/store.ts`:** `getCoinPacks()`, `createCoinOrder(packId, idempotencyKey)`, `getCoinOrder(orderId)`, `confirmCoinOrder(orderId, { gatewayPaymentId, signature })`.
- **`lib/api/infinite-game.ts:43`:** `revealInfiniteHint({ gameId, expectedCost })`, returning `{ hint, coinsSpent, balance, hintsUsed, hintsLeft }`.
- **`lib/api/infinite-tiers.ts`:** add `getScoreEvents(cursor?)`.
- **Delete** `lib/api/verification.ts`, `lib/api/rewards.ts` and their barrel entries (`lib/api/index.ts:13-17`).
- **`types/index.ts`:**
  - `Game`: add `hintCost: number | null` and `hintCoinsSpent`. Mark `hintsEnabled` deprecated.
  - `getMe` response: add `coinBalance: number`.
  - Daily and Infinite guess responses: add `coins?: { awarded: number; balance: number }`.
  - `ApiErrorCode`: add the codes in §4.4 and drop the removed ones.
- **`types/infinite.ts`:**
  - `TierDefinition`: add `hintCost` and `reward: { type: "star" } | null`. Remove `rewardInr`.
  - `InfiniteTiersResponse`: add `demotionPenalty`, `decay`, `coins`.
  - `InfiniteMeResponse`: add `hintCost`, `stars`, `completedCycles`, `lastDecay`. Remove `reward`.
  - `TierChange`: add `carriedPoints`, `penalty`, `entryPoints`.
- **`types/notifications.ts:8-21`:** the new union is `promotion | demotion_risk | demotion | coins_purchased | payment_failed | points_decayed`. Delete `MONEY_NOTIFICATION_TYPES`.
- **Delete `types/rewards.ts`.**
- **Sync flags** (`lib/api/sync.ts:6-17`, `ALL_FLAGS` in `lib/sync.ts:112-124`): replace `rewards` with `wallet`. Bind `wallet` to the coin chip (`GET /wallet`) and the Coins screen. The DiamondStatus and TierHistory consumers of `rewards` move to `infinite` (see 5.3).

### 5.2 Remove: one version of every screen

- **`lib/flags.ts:17` `MONEY_ENABLED`:** delete it, and keep only the "star" branch at every consumer:
  - `GameApp.tsx:78,128,134`
  - `Notifications.tsx:29,105,159`
  - `InfiniteTierPanel.tsx:279`
  - `TierLeaderboard.tsx:216`
  - `TierPromotionModal.tsx:142`
  - `DiamondStatusScreen.tsx:80,84,94,112`
  - `HowTiersWorkScreen.tsx:53`
  - `InfiniteHubScreen.tsx:99,132,144,440`
  - `TierHistoryScreen.tsx:112`
- **Verification:** delete `components/screens/VerificationFlowScreen.tsx`, `components/ConfirmEmailVerification.tsx` and `app/(game)/verify-email/[token]/page.tsx`. Remove the `verify` screen from `lib/screen-context.tsx:19,27`, and the `onVerify` props and mount in `GameApp.tsx:78,128,134-136`.
- **Promotion modal:** remove the "Verify mobile number" button (`TierPromotionModal.tsx:211-223`).
- **`formatInr`** (`lib/tiers.ts:35-37`) stays, but only for pack prices (`pricePaise / 100`).

### 5.3 Screens (PRD §6)

| # | Screen | Files | Change |
|---|---|---|---|
| 1 | Infinite hub | `InfiniteHubScreen.tsx` | Coin chip in the `ScreenHeader` trailing slot, left of the TierChip (`:204`, `:504`). Diamond card (`:144-151`): "₹100 every 30 days" becomes "*N* tiers to Diamond" (`me.tier − 1`). Remove ₹ from `:99-100` and `:132`. |
| 2 | Tier leaderboard | `TierLeaderboard.tsx:216-220,377` | Remove `rewardLine` ("Diamond earns ₹100") |
| 3 | How tiers work | `HowTiersWorkScreen.tsx` | Hints column (`:158`, `:180`) shows "1,000 coins" for `hintCost > 0` and "Free" for 0. `targetsLine` (`:218-225`) reads "hint 1,000 coins" / "free hints". Rules block (`:80-96`): add "+10 coins per solved word", "Moving down keeps 20% minus 50 points", and "A day without games costs 5% of your points (at least 10)", all from `tiers.coins`, `demotionPenalty` and `decay`. The Diamond line (`:89-94`) becomes the star version only. Update `:129` and `:183` too. |
| 4 | Infinite board | `PlayScreen.tsx` | **Hint logic** (`:986-1006`) uses `game.hintCost`: 0 is the existing free path, `null` shows `HintsOffNotice`, and `> 0` shows a "Need a hint?" row with a **1,000-coin button**. That row replaces the notice on mobile (`:1069-1088`, `:1211`) and in the desktop right panel (`:1118-1137`, `:1231`). Add the coin chip to the mobile top bar (`:1024-1061`). New **confirm-hint sheet** and **not-enough-coins sheet** (see 5.4). Disable the button once `hintRevealed`. |
| 5 | Game result | `InfiniteTierPanel.tsx` `TierResultCard` (`:166-307`); Daily `DailyRevealScreen` (`PlayScreen.tsx:431-685`) | New row "+10 coins for the solve · 2,350" from `coins.awarded` and `coins.balance`, between "Today counts" (`:230-255`) and the stats grid (`:257-274`). Hide it when `awarded` is 0. Remove the ₹ line (`:279`). |
| 6 | Coins *(new)* | new `CoinsScreen.tsx`, `{ name: "coins" }` in `lib/screen-context.tsx` and `GameApp.tsx` | Balance card (`GET /wallet`). The 3,000 coins for ₹10 pack (`GET /store/coin-packs`). Purchase terms (§5.5). Activity ledger (`GET /wallet/transactions`, paged by `nextCursor`), labelled: `earn_solve` "Solved a word", `purchase` "Bought 3,000 coins", `hint_spend` "Hint", `refund`, `adjustment`. Purchase-done sheet (mobile) or modal (web) with `coinsCredited` and the new balance. |
| 7 | Promotion | `TierPromotionModal.tsx:145-153` | Remove "where every 30 days pays ₹100" |
| 8 | At risk | `InfiniteHubScreen.tsx` `AtRiskView` (`:472-480`) | "₹100 cycle" becomes "Diamond cycle". Warning: "One more miss moves you down, keeping 20% of your points minus 50" (`demotionPenalty`). |
| 9 | Diamond | `DiamondStatusScreen.tsx` | Title "Diamond" (`:94`). Remove `getRewards`, `getVerificationStatus`, `verificationCard` (`:154-177`), `payoutsList` (`:179-198`) and the "Add bank account" CTA. Stars and completed cycles come from **`/infinite/me` `stars` / `completedCycles`**, not `rewards.payouts` (`:201-247`). CTA "Play next word". Cache keys `infinite:rewards` and `infinite:verification` go. |
| 10 | Notifications | `Notifications.tsx` `describe()` | Remove `reward_earned`, `payout_sent`, `payout_failed` and `verification_needed` (`:158-200`) and the money filter (`:27-30`). Add `coins_purchased`, `payment_failed` and `points_decayed` (copy in §4.2). The promotion-to-Diamond copy (`:97-110`) is star only. |
| 11 | Demotion | `TierPromotionModal.tsx` `PromotionScreen` (`:179-188`) | "Points carried in" shows `lastChange.entryPoints` (130), with the breakdown "20% of 900 = 180 · −50 penalty" from `oldScore`, `carriedPoints` and `penalty`. Remove the ₹100 line. |
| 12 | Tier history | `TierHistoryScreen.tsx` | Cycle rows come from `/infinite/me` `completedCycles` (instead of `getRewards()` at `:69-73`, `:114-120`). They read "Diamond star" (`:142`). Demotion rows can show the penalty. Optional: a points feed from `GET /infinite/score-events`. |
| 13 | Public leaderboard | `TierLeaderboard.tsx` (`publicView`) | ₹100 footnote removed (same `rewardLine`) |
| — | Web header | `components/Nav.tsx:153-184` (desktop), `:186-236` (burger) | Coin chip left of the TierChip, linking to Coins. Value from `/auth/me` `coinBalance`, refreshed on the `me`/`wallet` flags and immediately from any `coins.balance` / `balance` in a response. |
| — | Home, Daily win | `HomeScreen`, `DailyRevealScreen` | Coin chip in the top bar. +10 coins row on Daily solves. |
| — | Info pages | see 5.5 | Copy |

### 5.4 Flows

**Hint (paid tier)**
1. The button shows "1,000 coins" (`game.hintCost`). Tap opens the confirm sheet: "Use a hint for 1,000 coins? Balance after: 1,340".
2. If `balance < hintCost`, open the not-enough-coins sheet instead, with the 3,000-coin pack. After a purchase, return to the confirm sheet.
3. Confirm sends `POST /game/infinite/hint { gameId: game.id, expectedCost: game.hintCost }`. Show `hint` and set the chip to `balance`.
4. Error handling:
   - `402` opens the not-enough-coins sheet using the `balance` and `required` from the body.
   - `409 HINT_COST_CHANGED` re-shows the confirm sheet with the new `hintCost`.
   - `409 NOTHING_TO_REVEAL` hides the button.
   - `403` shows `HintsOffNotice`.
5. Keep the client-side "unlocks after guess 4" rule (`PlayScreen.tsx:49`) unless product says otherwise. The server doesn't enforce it.

**Buy coins (Razorpay Checkout)**
1. `POST /store/orders { packId }` with `Idempotency-Key: <uuid per tap>`. On `503 PAYMENTS_NOT_CONFIGURED`, show "Coming soon".
2. Load `https://checkout.razorpay.com/v1/checkout.js` and open:
   `new Razorpay({ key: gateway.key, order_id: gateway.orderId, amount: gateway.amountPaise, currency: gateway.currency, name: "GuessWord", description: "3,000 coins", prefill: { email }, handler, modal: { ondismiss } })`.
3. `handler(r)` sends `POST /store/orders/{orderId}/confirm { gatewayPaymentId: r.razorpay_payment_id, signature: r.razorpay_signature }`. `200` or `409 ALREADY_CREDITED` opens the purchase-done sheet and calls `invalidate("wallet", "me")`.
4. If confirm fails on the network, poll `GET /store/orders/{orderId}` a few times. The webhook will have credited it.
5. `402`, `rzp.on("payment.failed")` or dismiss: "Payment didn't go through. You weren't charged."
6. If the site has a CSP, allow `checkout.razorpay.com` (script) and `api.razorpay.com` (frame).

### 5.5 Copy pages

- **How to play** (`app/(info)/how-to-play/page.tsx:118`): "Hints are off from Copper up" becomes "From Copper up, a hint costs 1,000 coins. You earn 10 coins for every solved word." Also update JSON-LD step 3 (`:47`).
- **FAQ** (`app/(info)/faq/page.tsx`):
  - Hints answer (`:108-112`).
  - "Is GuessWord free?" (`:89-92`): free to play, with optional coin purchases.
  - Add "What are coins?", plus questions on decay and the demotion penalty in `TIER_FAQS` (`:29-60`).
- **Terms** (`app/(info)/terms/page.tsx`): add a Coins & purchases section. It should cover:
  - ₹10 for 3,000 coins, GST inclusive, paid through Razorpay.
  - Coins have no cash value, can't be withdrawn or transferred, and don't expire.
  - Purchases are non-refundable except where the law requires a refund or for a duplicate charge.
  - Fix the "no in-app notification system" comment at `:52-53`.
- **Privacy** (`app/(info)/privacy-policy/page.tsx`): payments are processed by Razorpay. GuessWord stores the order and payment ids, never card or UPI details. Mobile numbers and bank details are no longer collected, and stored ones are deleted.
- **`public/llms.txt`:** update the hint line (`:11`). `:16` is out of date.

---

## 6. Rollout (PRD §10)

| Step | Backend | Frontend |
|---|---|---|
| 1. Remove verification and ₹100 | Deploy this release with `TierConfig` tiers 1–6 `hintCost: null` and no payment env. Run `scripts/purge-verification-data.js` (dry run first) after pending payouts are settled. | Ship §5.2, plus the ₹100 copy removals |
| 2. Wallet and earning | Nothing more. Coins are earned from step 1. | Coin chip, result-sheet row, Coins screen (balance and ledger) |
| 3. Paid hints and store | Set `hintCost: 1000` for tiers 1–6 (or delete the override). Set the payment env and webhook. | Hint sheets, purchase flow |

To ship everything at once, leave the default config (1,000 in tiers 1–6) and set the payment env at release.

## 7. Operations checklist

- **Razorpay settings (temporary):** they're hardcoded in `config/razorpay.js` (test keys), and those values win over the environment variables below. That's safe only with **test** keys, because the repo is public. Before going live, move the live keys to the environment and empty that file.
- **Env (new):**
  - `PAYMENT_PROVIDER=razorpay`
  - `RAZORPAY_KEY_ID`
  - `RAZORPAY_KEY_SECRET`
  - `RAZORPAY_WEBHOOK_SECRET`
  - `PAYMENT_PROVIDER=mock` is for local development and tests only.
- **Env (delete):** `WHATSAPP_*`, `VERIFICATION_SECRET`, `SMS_PROVIDER`, `PENNY_DROP_PROVIDER`.
- **Razorpay dashboard:**
  - Webhook URL `https://<api host>/webhooks/payments` (not under `/api`).
  - Events `payment.captured`, `payment.failed`, `order.paid`.
  - Turn on auto-capture.
- **`TierConfig.decay.effectiveFrom`:** the IST release day.
- **MongoDB transactions** are required for wallet writes. Atlas has them. On a standalone local mongod, wallet writes fall back to running without a transaction, and a warning is logged once.
- **Secrets that were in the repo:** `config/whatsappDemo.js` and the hardcoded `VERIFICATION_SECRET` are deleted, but they remain in git history. **Rotate the WhatsApp access token and app secret.** Remove the Meta webhook subscription.
- **Data deletion (PRD §3.1, within 30 days):** `node scripts/purge-verification-data.js`, then `--apply`. It keeps bank data for players with an unpaid payout and lists them; re-run once those are paid. Paid `payouts` records are kept.
- **Nightly job load:** Tier 8 members with points are now settled every night until decay takes them to 0.

## 8. Not built, and open questions

| Item | Status |
|---|---|
| Flag abnormal solve rates (PRD §7) | Not built. The data is in `CoinTransaction` / `ScoreEvent`. |
| Admin refunds and adjustments | Ledger types exist; there's no endpoint yet |
| Diamond star notification | PRD lists none. The star shows on `/infinite/me`. |
| Receipt GST details (GSTIN, invoice number) | Receipt shows the order, coins and amount incl. GST. Finance needs to supply the invoice fields. |
| PRD open questions | Defaults used: Daily earns coins · hinted solves score normally · 1 hint per round (the clue) · decay 5% / min 10 with no pause for breaks · Razorpay · one pack. Legal review of paid hints is still open. |
