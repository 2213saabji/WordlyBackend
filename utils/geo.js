// Coarse location (country + first-level region) of a request, from the
// geolocation headers the hosting edge adds after looking up the client's
// IP. No IP database and no third-party lookup: the IP never leaves the
// edge, and nothing here stores it.
//
//   Vercel (default)  x-vercel-ip-country         'IN'
//                     x-vercel-ip-country-region  'RJ' (region part of ISO 3166-2)
//                     Vercel sets these itself, overwriting anything the
//                     client sends, so they can be trusted.
//   Cloudflare        cf-ipcountry, cf-region-code, cf-region
//                     Only read with TRUST_CLOUDFLARE_GEO=true (the API is
//                     behind Cloudflare with "Add visitor location headers"
//                     on). Otherwise a client could send them itself.
//
// Local development has neither, so the location is null there.

const { lookupRegion } = require('./regions');

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

// 'XX' = unknown, 'T1' = Tor exit node (Cloudflare).
const UNKNOWN_COUNTRIES = new Set(['XX', 'T1', 'ZZ']);

function header(req, name) {
  const v = req.headers && req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string' || !s.trim()) return null;
  try {
    return decodeURIComponent(s.trim());
  } catch {
    return s.trim();
  }
}

function countryName(code) {
  try {
    return countryNames.of(code) || null;
  } catch {
    return null;
  }
}

// { countryCode, country, regionCode, region, regionType, source } or null
// when the request carries no usable location.
//   countryCode 'IN', country 'India', regionCode 'RJ', region 'Rajasthan',
//   regionType 'State'. region/regionType are null for a code the table in
//   utils/regions.js doesn't name (the code is still kept).
function locationFromRequest(req) {
  let source = null;
  let countryCode = header(req, 'x-vercel-ip-country');
  let rawRegion = null;
  let regionNameFromEdge = null;

  if (countryCode) {
    source = 'vercel';
    rawRegion = header(req, 'x-vercel-ip-country-region');
  } else if (process.env.TRUST_CLOUDFLARE_GEO === 'true' && header(req, 'cf-ipcountry')) {
    source = 'cloudflare';
    countryCode = header(req, 'cf-ipcountry');
    rawRegion = header(req, 'cf-region-code');
    regionNameFromEdge = header(req, 'cf-region');
  }
  if (!countryCode) return null;

  countryCode = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode) || UNKNOWN_COUNTRIES.has(countryCode)) return null;

  const { regionCode, region, regionType } = lookupRegion(countryCode, rawRegion);
  return {
    countryCode,
    country: countryName(countryCode),
    regionCode,
    region: region || regionNameFromEdge || null,
    regionType,
    source,
  };
}

module.exports = { locationFromRequest, countryName };
