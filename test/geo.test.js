// Country + region of a signup / "Continue with Google" request, from the
// edge's geolocation headers (utils/geo.js, utils/regions.js).
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { locationFromRequest } = require('../utils/geo');
const { lookupRegion } = require('../utils/regions');

const vercel = (country, region) => ({
  headers: { 'x-vercel-ip-country': country, ...(region !== undefined ? { 'x-vercel-ip-country-region': region } : {}) },
});

afterEach(() => { delete process.env.TRUST_CLOUDFLARE_GEO; });

// The table from the request: country, its local term, an example region.
const EXAMPLES = [
  ['IN', 'RJ', 'India', 'Rajasthan', 'State'],
  ['US', 'CA', 'United States', 'California', 'State'],
  ['CA', 'ON', 'Canada', 'Ontario', 'Province'],
  ['AU', 'VIC', 'Australia', 'Victoria', 'State'],
  ['BR', 'SP', 'Brazil', 'São Paulo', 'State'],
  ['DE', 'BY', 'Germany', 'Bavaria', 'State'],
  ['FR', 'IDF', 'France', 'Île-de-France', 'Region'],
  ['GB', 'ENG', 'United Kingdom', 'England', 'Country'],
  ['JP', '13', 'Japan', 'Tokyo', 'Prefecture'],
  ['CN', 'GD', 'China', 'Guangdong', 'Province'],
  ['MX', 'JAL', 'Mexico', 'Jalisco', 'State'],
  ['AE', 'DU', 'United Arab Emirates', 'Dubai', 'Emirate'],
];

for (const [countryCode, regionCode, country, region, regionType] of EXAMPLES) {
  test(`${countryCode}-${regionCode} → ${country}, ${region} (${regionType})`, () => {
    assert.deepEqual(locationFromRequest(vercel(countryCode, regionCode)), {
      countryCode, country, regionCode, region, regionType, source: 'vercel',
    });
  });
}

test('local terms that differ inside a country', () => {
  assert.deepEqual(lookupRegion('IN', 'DL'), { regionCode: 'DL', region: 'Delhi', regionType: 'Union territory' });
  assert.equal(lookupRegion('CA', 'YT').regionType, 'Territory');
  assert.equal(lookupRegion('AU', 'ACT').regionType, 'Territory');
  assert.equal(lookupRegion('CN', 'XZ').regionType, 'Autonomous region');
  assert.equal(lookupRegion('CN', 'BJ').regionType, 'Municipality');
  assert.equal(lookupRegion('US', 'DC').regionType, 'District');
  assert.equal(lookupRegion('MX', 'CMX').region, 'Mexico City');
});

test('older / alternative codes resolve to the current region', () => {
  assert.equal(lookupRegion('IN', 'TS').region, 'Telangana');
  assert.equal(lookupRegion('IN', 'OR').region, 'Odisha');
  assert.equal(lookupRegion('IN', 'UT').region, 'Uttarakhand');
  assert.equal(lookupRegion('CN', '44').region, 'Guangdong', 'pre-2017 numeric code');
  assert.equal(lookupRegion('FR', '20R').region, 'Corsica');
  assert.equal(lookupRegion('GB', 'CYM').region, 'Wales');
  assert.equal(lookupRegion('MX', 'DIF').region, 'Mexico City');
  assert.equal(lookupRegion('JP', '1').region, 'Hokkaido', 'unpadded prefecture number');
});

test('lower-case headers are normalised', () => {
  const loc = locationFromRequest(vercel('in', 'rj'));
  assert.equal(loc.countryCode, 'IN');
  assert.equal(loc.region, 'Rajasthan');
});

test('every country table entry has a name and a type', () => {
  const { REGIONS } = require('../utils/regions');
  for (const [cc, c] of Object.entries(REGIONS)) {
    for (const code of Object.keys(c.names)) {
      const r = lookupRegion(cc, code);
      assert.ok(r.region && r.regionType, `${cc}-${code}`);
    }
    for (const [alias, target] of Object.entries(c.aliases || {})) {
      assert.ok(c.names[target], `${cc} alias ${alias} → ${target}`);
    }
  }
});

test('a country outside the table keeps its region code, with no name', () => {
  assert.deepEqual(locationFromRequest(vercel('NG', 'LA')), {
    countryCode: 'NG', country: 'Nigeria', regionCode: 'LA', region: null, regionType: null, source: 'vercel',
  });
});

test('an unknown code in a known country keeps the code', () => {
  assert.deepEqual(lookupRegion('IN', 'QQ'), { regionCode: 'QQ', region: null, regionType: null });
});

test('country without a region', () => {
  const loc = locationFromRequest(vercel('SG'));
  assert.equal(loc.country, 'Singapore');
  assert.equal(loc.regionCode, null);
  assert.equal(loc.region, null);
});

test('no geo headers (local development) → null', () => {
  assert.equal(locationFromRequest({ headers: {} }), null);
});

test('unknown or invalid country → null', () => {
  assert.equal(locationFromRequest(vercel('XX')), null);
  assert.equal(locationFromRequest(vercel('India')), null);
});

test('Cloudflare headers are ignored unless TRUST_CLOUDFLARE_GEO=true (a client could send them)', () => {
  const req = { headers: { 'cf-ipcountry': 'JP', 'cf-region-code': '13', 'cf-region': 'Tokyo' } };
  assert.equal(locationFromRequest(req), null);
  process.env.TRUST_CLOUDFLARE_GEO = 'true';
  assert.deepEqual(locationFromRequest(req), {
    countryCode: 'JP', country: 'Japan', regionCode: '13', region: 'Tokyo', regionType: 'Prefecture', source: 'cloudflare',
  });
});

test('Cloudflare region name is used when the table has none', () => {
  process.env.TRUST_CLOUDFLARE_GEO = 'true';
  const loc = locationFromRequest({ headers: { 'cf-ipcountry': 'NG', 'cf-region-code': 'LA', 'cf-region': 'Lagos' } });
  assert.equal(loc.region, 'Lagos');
});

test('Vercel wins over Cloudflare when both are present', () => {
  process.env.TRUST_CLOUDFLARE_GEO = 'true';
  const loc = locationFromRequest({ headers: { 'x-vercel-ip-country': 'IN', 'x-vercel-ip-country-region': 'RJ', 'cf-ipcountry': 'US' } });
  assert.equal(loc.countryCode, 'IN');
});
