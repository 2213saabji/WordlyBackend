const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication token missing' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

// For public endpoints that show extra data to signed-in players (e.g. the
// Infinite tier board's pinned "me" row). No token → continue signed out,
// with req.userId unset. A token that's present but invalid or expired
// still gets 401, so the client refreshes it instead of silently seeing the
// signed-out view.
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header) return next();
  return requireAuth(req, res, next);
}

module.exports = { requireAuth, optionalAuth };
