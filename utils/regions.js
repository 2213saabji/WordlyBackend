// First-level region names for the signup / sign-in location (utils/geo.js).
// The geo headers give the region as the region part of its ISO 3166-2
// code ('RJ' for IN-RJ, '13' for JP-13); this turns that into a name and
// the local term for it. Countries not listed here still get their code
// stored; only the name is missing.
//
// Per country: `type` is the usual term (India: State, Canada: Province,
// Japan: Prefecture …); an entry given as [name, type] overrides it (Delhi
// is a Union territory, Yukon a Territory). `aliases` map older or
// alternative codes some geo databases still return to the current one.

const REGIONS = {
  IN: {
    type: 'State',
    names: {
      AN: ['Andaman and Nicobar Islands', 'Union territory'], AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh',
      AS: 'Assam', BR: 'Bihar', CH: ['Chandigarh', 'Union territory'], CG: 'Chhattisgarh',
      DH: ['Dadra and Nagar Haveli and Daman and Diu', 'Union territory'], DL: ['Delhi', 'Union territory'],
      GA: 'Goa', GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh', JK: ['Jammu and Kashmir', 'Union territory'],
      JH: 'Jharkhand', KA: 'Karnataka', KL: 'Kerala', LA: ['Ladakh', 'Union territory'],
      LD: ['Lakshadweep', 'Union territory'], MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur',
      ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OD: 'Odisha', PY: ['Puducherry', 'Union territory'],
      PB: 'Punjab', RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TG: 'Telangana', TR: 'Tripura',
      UP: 'Uttar Pradesh', UK: 'Uttarakhand', WB: 'West Bengal',
    },
    aliases: { CT: 'CG', OR: 'OD', TS: 'TG', UT: 'UK', DN: 'DH', DD: 'DH' },
  },
  US: {
    type: 'State',
    names: {
      AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
      CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
      IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
      ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
      MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
      NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
      OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
      TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
      WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: ['District of Columbia', 'District'],
      PR: ['Puerto Rico', 'Territory'], GU: ['Guam', 'Territory'], VI: ['U.S. Virgin Islands', 'Territory'],
      AS: ['American Samoa', 'Territory'], MP: ['Northern Mariana Islands', 'Territory'],
    },
  },
  CA: {
    type: 'Province',
    names: {
      AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
      NS: 'Nova Scotia', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan',
      NT: ['Northwest Territories', 'Territory'], NU: ['Nunavut', 'Territory'], YT: ['Yukon', 'Territory'],
    },
    aliases: { PQ: 'QC', NF: 'NL' },
  },
  AU: {
    type: 'State',
    names: {
      NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland', WA: 'Western Australia', SA: 'South Australia',
      TAS: 'Tasmania', ACT: ['Australian Capital Territory', 'Territory'], NT: ['Northern Territory', 'Territory'],
    },
  },
  BR: {
    type: 'State',
    names: {
      AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
      DF: ['Distrito Federal', 'Federal District'], ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão',
      MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
      PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul',
      RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
    },
  },
  DE: {
    type: 'State',
    names: {
      BW: 'Baden-Württemberg', BY: 'Bavaria', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen', HH: 'Hamburg',
      HE: 'Hesse', MV: 'Mecklenburg-Western Pomerania', NI: 'Lower Saxony', NW: 'North Rhine-Westphalia',
      RP: 'Rhineland-Palatinate', SL: 'Saarland', SN: 'Saxony', ST: 'Saxony-Anhalt', SH: 'Schleswig-Holstein',
      TH: 'Thuringia',
    },
  },
  FR: {
    type: 'Region',
    names: {
      ARA: 'Auvergne-Rhône-Alpes', BFC: 'Bourgogne-Franche-Comté', BRE: 'Brittany', CVL: 'Centre-Val de Loire',
      COR: 'Corsica', GES: 'Grand Est', HDF: 'Hauts-de-France', IDF: 'Île-de-France', NOR: 'Normandy',
      NAQ: 'Nouvelle-Aquitaine', OCC: 'Occitanie', PDL: 'Pays de la Loire', PAC: "Provence-Alpes-Côte d'Azur",
      971: ['Guadeloupe', 'Overseas region'], 972: ['Martinique', 'Overseas region'],
      973: ['French Guiana', 'Overseas region'], 974: ['Réunion', 'Overseas region'], 976: ['Mayotte', 'Overseas region'],
    },
    aliases: { '20R': 'COR' },
  },
  GB: {
    type: 'Country',
    names: { ENG: 'England', SCT: 'Scotland', WLS: 'Wales', NIR: 'Northern Ireland' },
    aliases: { CYM: 'WLS' },
  },
  JP: {
    type: 'Prefecture',
    names: {
      '01': 'Hokkaido', '02': 'Aomori', '03': 'Iwate', '04': 'Miyagi', '05': 'Akita', '06': 'Yamagata',
      '07': 'Fukushima', '08': 'Ibaraki', '09': 'Tochigi', 10: 'Gunma', 11: 'Saitama', 12: 'Chiba', 13: 'Tokyo',
      14: 'Kanagawa', 15: 'Niigata', 16: 'Toyama', 17: 'Ishikawa', 18: 'Fukui', 19: 'Yamanashi', 20: 'Nagano',
      21: 'Gifu', 22: 'Shizuoka', 23: 'Aichi', 24: 'Mie', 25: 'Shiga', 26: 'Kyoto', 27: 'Osaka', 28: 'Hyogo',
      29: 'Nara', 30: 'Wakayama', 31: 'Tottori', 32: 'Shimane', 33: 'Okayama', 34: 'Hiroshima', 35: 'Yamaguchi',
      36: 'Tokushima', 37: 'Kagawa', 38: 'Ehime', 39: 'Kochi', 40: 'Fukuoka', 41: 'Saga', 42: 'Nagasaki',
      43: 'Kumamoto', 44: 'Oita', 45: 'Miyazaki', 46: 'Kagoshima', 47: 'Okinawa',
    },
  },
  CN: {
    type: 'Province',
    names: {
      BJ: ['Beijing', 'Municipality'], TJ: ['Tianjin', 'Municipality'], HE: 'Hebei', SX: 'Shanxi',
      NM: ['Inner Mongolia', 'Autonomous region'], LN: 'Liaoning', JL: 'Jilin', HL: 'Heilongjiang',
      SH: ['Shanghai', 'Municipality'], JS: 'Jiangsu', ZJ: 'Zhejiang', AH: 'Anhui', FJ: 'Fujian', JX: 'Jiangxi',
      SD: 'Shandong', HA: 'Henan', HB: 'Hubei', HN: 'Hunan', GD: 'Guangdong', GX: ['Guangxi', 'Autonomous region'],
      HI: 'Hainan', CQ: ['Chongqing', 'Municipality'], SC: 'Sichuan', GZ: 'Guizhou', YN: 'Yunnan',
      XZ: ['Tibet', 'Autonomous region'], SN: 'Shaanxi', GS: 'Gansu', QH: 'Qinghai',
      NX: ['Ningxia', 'Autonomous region'], XJ: ['Xinjiang', 'Autonomous region'],
      HK: ['Hong Kong', 'Special administrative region'], MO: ['Macau', 'Special administrative region'],
    },
    // The numeric codes ISO used before 2017.
    aliases: {
      11: 'BJ', 12: 'TJ', 13: 'HE', 14: 'SX', 15: 'NM', 21: 'LN', 22: 'JL', 23: 'HL', 31: 'SH', 32: 'JS', 33: 'ZJ',
      34: 'AH', 35: 'FJ', 36: 'JX', 37: 'SD', 41: 'HA', 42: 'HB', 43: 'HN', 44: 'GD', 45: 'GX', 46: 'HI', 50: 'CQ',
      51: 'SC', 52: 'GZ', 53: 'YN', 54: 'XZ', 61: 'SN', 62: 'GS', 63: 'QH', 64: 'NX', 65: 'XJ', 91: 'HK', 92: 'MO',
    },
  },
  MX: {
    type: 'State',
    names: {
      AGU: 'Aguascalientes', BCN: 'Baja California', BCS: 'Baja California Sur', CAM: 'Campeche', CHP: 'Chiapas',
      CHH: 'Chihuahua', CMX: ['Mexico City', 'Federal entity'], COA: 'Coahuila', COL: 'Colima', DUR: 'Durango',
      GUA: 'Guanajuato', GRO: 'Guerrero', HID: 'Hidalgo', JAL: 'Jalisco', MEX: 'State of Mexico', MIC: 'Michoacán',
      MOR: 'Morelos', NAY: 'Nayarit', NLE: 'Nuevo León', OAX: 'Oaxaca', PUE: 'Puebla', QUE: 'Querétaro',
      ROO: 'Quintana Roo', SLP: 'San Luis Potosí', SIN: 'Sinaloa', SON: 'Sonora', TAB: 'Tabasco',
      TAM: 'Tamaulipas', TLA: 'Tlaxcala', VER: 'Veracruz', YUC: 'Yucatán', ZAC: 'Zacatecas',
    },
    aliases: { DIF: 'CMX' },
  },
  AE: {
    type: 'Emirate',
    names: {
      AZ: 'Abu Dhabi', AJ: 'Ajman', DU: 'Dubai', FU: 'Fujairah', RK: 'Ras Al Khaimah', SH: 'Sharjah',
      UQ: 'Umm Al Quwain',
    },
  },
};

// { regionCode, region, regionType } for a country's region code, with
// region/regionType null when the country or code isn't in the table. The
// code is normalised: upper case, aliases resolved, Japan's prefectures
// zero-padded ('1' → '01').
function lookupRegion(countryCode, rawRegionCode) {
  if (!rawRegionCode) return { regionCode: null, region: null, regionType: null };
  let code = String(rawRegionCode).trim().toUpperCase();
  const country = REGIONS[countryCode];
  if (!country) return { regionCode: code, region: null, regionType: null };

  if (countryCode === 'JP' && /^\d$/.test(code)) code = `0${code}`;
  if (country.aliases && country.aliases[code]) code = country.aliases[code];
  const entry = country.names[code];
  if (!entry) return { regionCode: code, region: null, regionType: null };
  const [region, type] = Array.isArray(entry) ? entry : [entry, country.type];
  return { regionCode: code, region, regionType: type };
}

// The usual term for a country's first-level regions, or null.
function regionTermFor(countryCode) {
  return REGIONS[countryCode] ? REGIONS[countryCode].type : null;
}

module.exports = { REGIONS, lookupRegion, regionTermFor };
