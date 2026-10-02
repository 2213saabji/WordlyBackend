// TEMPORARY — Razorpay settings, hardcoded at the owner's request instead of
// environment variables. These values take precedence over the
// environment (see setting() in utils/payments.js); a setting left empty
// here falls back to the environment variable of the same name.
//
// TEST MODE KEYS ONLY. This repo is public, so anyone can read these. With
// a live key secret, anyone could forge payment signatures (free coins) and
// call the Razorpay API on this account. Before going live: put the live
// keys in the environment, empty these values (or delete this file and its
// require in utils/payments.js), and regenerate the test key secret.
module.exports = {
  PAYMENT_PROVIDER: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_test_TjBf41rDE97NEX',
  RAZORPAY_KEY_SECRET: 'ny1S0Ia0f2mzIxZhrYk4PXHE',
  // Razorpay Dashboard > Webhooks: the secret chosen for
  // https://api.guessword.games/webhooks/payments (the same value goes there).
  RAZORPAY_WEBHOOK_SECRET: '8W5VJWLB0hLOjw9rx9ltW1iRw1xPy23j',
};
