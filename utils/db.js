const mongoose = require('mongoose');

// On Vercel every request can land on a cold serverless instance, and the same
// warm instance is reused for later requests. So the connection has to be
// (a) created lazily per instance, (b) cached across invocations, and
// (c) awaited before any query runs — otherwise the query just sits in
// mongoose's buffer and dies with "Operation x.findOne() buffering timed out".
// The cache hangs off globalThis because module state can be re-evaluated
// between invocations while the process survives.
let cached = globalThis.__mongooseConn;

if (!cached) {
  cached = globalThis.__mongooseConn = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }

  if (!cached.promise) {
    const uri = process.env.MONGO_URI;

    if (!uri) {
      throw new Error(
        'MONGO_URI is not set. On Vercel it must be added under ' +
          'Project Settings > Environment Variables (the local .env file is not deployed).'
      );
    }

    cached.promise = mongoose
      .connect(uri, {
        // Fail fast with the real reason (auth / IP allowlist / DNS) instead of
        // letting the query buffer expire first and hide it.
        serverSelectionTimeoutMS: 8000,
        // Serverless instances are short-lived; don't hold a big pool open.
        maxPoolSize: 5,
      })
      .then((m) => m)
      .catch((err) => {
        // Let the next request retry instead of caching a dead promise forever.
        cached.promise = null;
        throw err;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

module.exports = { connectDB };
