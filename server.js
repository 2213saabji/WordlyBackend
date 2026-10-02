const dns = require('dns').promises;
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const { connectDB, dbTiming } = require('./utils/db');

// Start connecting now, so the connection's DNS lookups and handshakes run
// while the routes below load, instead of after the first request arrives.
// Errors are left to the first request's connectDB(), which retries.
connectDB().catch(() => {});

const authRoutes = require('./routes/authRoutes');
const gameRoutes = require('./routes/gameRoutes');
const groupRoutes = require('./routes/groupRoutes');
const leaderboardRoutes = require('./routes/leaderboardRoutes');
const webauthnRoutes = require('./routes/webauthnRoutes');
const contactRoutes = require('./routes/contactRoutes');
const cronRoutes = require('./routes/cronRoutes');
const infiniteRoutes = require('./routes/infiniteRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const walletRoutes = require('./routes/walletRoutes');
const storeRoutes = require('./routes/storeRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const { gone } = require('./routes/goneRoutes');
const { requireAuth } = require('./middleware/auth');
const { legacyRewardsMe } = require('./controllers/infiniteController');
const syncRoutes = require('./routes/syncRoutes');
const webhookRoutes = require('./routes/webhookRoutes');

const app = express();
const PORT = process.env.PORT || 8888;

// Middleware
const allowedOrigins = [
  'https://www.guessword.games',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://wordly-frontend-steel.vercel.app',
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  // Readable by the frontend's JS, for cold-start measurements.
  exposedHeaders: ['Server-Timing', 'X-Cold-Start'],
};

// --- Cold-start diagnostics -------------------------------------------------
// Every response carries `Server-Timing: app;dur=…, db-wait;dur=…` (handler
// time; time spent waiting for the DB connection). The first request a new
// instance serves also gets boot (ms from process start until the app was
// ready) and db-connect (how long its connection took), `X-Cold-Start: 1`,
// and one log line in the Vercel logs.
let bootMs = null; // set once the app is fully set up, below
let servedFirstRequest = false;

app.use((req, res, next) => {
  const start = performance.now();
  const cold = !servedFirstRequest;
  servedFirstRequest = true;
  res.locals.dbWaitMs = 0;

  const writeHead = res.writeHead;
  res.writeHead = function writeHeadWithTiming(...args) {
    const metrics = [`app;dur=${(performance.now() - start).toFixed(1)}`, `db-wait;dur=${res.locals.dbWaitMs.toFixed(1)}`];
    if (cold) {
      const { connectMs } = dbTiming();
      if (bootMs !== null) metrics.push(`boot;dur=${bootMs}`);
      if (connectMs !== null) metrics.push(`db-connect;dur=${connectMs}`);
      this.setHeader('X-Cold-Start', '1');
    }
    this.setHeader('Server-Timing', metrics.join(', '));
    return writeHead.apply(this, args);
  };

  if (cold) {
    res.on('finish', () => {
      console.log(JSON.stringify({
        coldStart: true,
        path: req.path,
        status: res.statusCode,
        bootMs,
        dbConnectMs: dbTiming().connectMs,
        dbWaitMs: Math.round(res.locals.dbWaitMs),
        requestMs: Math.round(performance.now() - start),
        sinceProcessStartMs: Math.round(performance.now()),
      }));
    });
  }
  next();
});

// Apply CORS to every route, including preflight requests.
app.use(cors(corsOptions));
// Before express.json(): webhook signatures are checked on the raw body.
// Outside /api, so the DB is connected only by the handlers that need it.
app.use('/webhooks', webhookRoutes);
app.use(express.json());

// Test Route
app.get('/', (req, res) => {
  res.send('Backend server is running!');
});

// Times a fresh DNS lookup of the connection string's host, the step a
// cold connection starts with. mongodb+srv:// needs an SRV and a TXT
// lookup; a stalled lookup in a serverless function waits ~5 s to retry.
async function timeDnsLookups() {
  let hostname;
  let srv;
  try {
    const uri = process.env.MONGO_URI || '';
    srv = uri.startsWith('mongodb+srv://');
    hostname = new URL(uri).hostname.split(',')[0];
  } catch {
    return { error: 'MONGO_URI is not a parseable URL' };
  }
  const time = async (fn) => {
    const t = performance.now();
    try {
      await fn();
      return Math.round(performance.now() - t);
    } catch (err) {
      return `failed after ${Math.round(performance.now() - t)} ms: ${err.code || err.message}`;
    }
  };
  return srv
    ? { scheme: 'mongodb+srv', srvMs: await time(() => dns.resolveSrv(`_mongodb._tcp.${hostname}`)), txtMs: await time(() => dns.resolveTxt(hostname)) }
    : { scheme: 'mongodb', lookupMs: await time(() => dns.lookup(hostname)) };
}

// Surfaces the actual driver error (bad URI, auth failure, IP not allowlisted)
// which otherwise only shows up in the Vercel logs, plus timings for
// diagnosing slow cold starts.
app.get('/health/db', async (req, res) => {
  const waitStart = performance.now();
  try {
    await connectDB();
    const waitedMs = Math.round(performance.now() - waitStart);
    const pingStart = performance.now();
    await mongoose.connection.db.admin().ping();
    const pingMs = Math.round(performance.now() - pingStart);
    res.json({
      ok: true,
      readyState: mongoose.connection.readyState,
      db: mongoose.connection.name,
      host: mongoose.connection.host,
      timing: {
        bootMs, // process start → app ready, for this instance
        uptimeMs: Math.round(performance.now()),
        dbConnectMs: dbTiming().connectMs, // this instance's connection
        waitedForDbMs: waitedMs, // this request (0 once connected)
        pingMs, // one round trip to the database
        dns: await timeDnsLookups(), // a fresh lookup, now
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, name: err.name, message: err.message, timing: { bootMs, dbTiming: dbTiming(), dns: await timeDnsLookups() } });
  }
});

// Every API request waits for the connection before it can issue a query.
app.use('/api', async (req, res, next) => {
  const waitStart = performance.now();
  try {
    await connectDB();
    res.locals.dbWaitMs = performance.now() - waitStart;
    next();
  } catch (err) {
    console.error('MongoDB connection error:', err);
    res.status(503).json({ message: `Database unavailable: ${err.message}` });
  }
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/game', gameRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/auth/webauthn', webauthnRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/infinite', infiniteRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/store', storeRoutes);
app.use('/api/analytics', analyticsRoutes);
// Removed in v0.2. GET /rewards/me still answers (no money, stars only)
// for apps that read it without asking; the rest is 410 Gone. Both go next
// release.
app.get('/api/rewards/me', requireAuth, legacyRewardsMe);
app.use(['/api/rewards', '/api/verification'], gone);
app.use('/api/sync', syncRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

// Every module above has loaded: this is how long this instance took to boot.
// (Deployed on Vercel; see the geo headers note in utils/geo.js.)
bootMs = Math.round(performance.now());

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// Exported so a serverless host can use the app directly as a handler.
module.exports = app;
