// Records where signups and "Continue with Google" come from (AuthEvent).
// Analytics only: a failure here is logged and never fails the sign-in.

const AuthEvent = require('../models/AuthEvent');

// The parts of a location (utils/geo.js) stored on User and AuthEvent.
function storedLocation(location) {
  if (!location) return null;
  const { countryCode, regionCode, region, regionType } = location;
  return { countryCode, regionCode, region, regionType };
}

async function recordAuthEvent({ event, userId, newAccount, location }) {
  try {
    await AuthEvent.create({
      event,
      user: userId || null,
      newAccount,
      ...(storedLocation(location) || {}),
    });
  } catch (err) {
    console.error(`recordAuthEvent(${event}) failed:`, err);
  }
}

module.exports = { storedLocation, recordAuthEvent };
