const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const { connectDB } = require('./utils/db');

const authRoutes = require('./routes/authRoutes');
const gameRoutes = require('./routes/gameRoutes');
const groupRoutes = require('./routes/groupRoutes');
const leaderboardRoutes = require('./routes/leaderboardRoutes');
const webauthnRoutes = require('./routes/webauthnRoutes');
const contactRoutes = require('./routes/contactRoutes');
const cronRoutes = require('./routes/cronRoutes');
const infiniteRoutes = require('./routes/infiniteRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const rewardRoutes = require('./routes/rewardRoutes');

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
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// Apply CORS to every route, including preflight requests.
app.use(cors(corsOptions));
app.use(express.json());

// Test Route
app.get('/', (req, res) => {
  res.send('Backend server is running!');
});

// Surfaces the actual driver error (bad URI, auth failure, IP not allowlisted)
// which otherwise only shows up in the Vercel logs.
app.get('/health/db', async (req, res) => {
  try {
    await connectDB();
    res.json({
      ok: true,
      readyState: mongoose.connection.readyState,
      db: mongoose.connection.name,
      host: mongoose.connection.host,
    });
  } catch (err) {
    res.status(500).json({ ok: false, name: err.name, message: err.message });
  }
});

// Every API request waits for the connection before it can issue a query.
app.use('/api', async (req, res, next) => {
  try {
    await connectDB();
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
app.use('/api/rewards', rewardRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// Exported so a serverless host can use the app directly as a handler.
module.exports = app;
