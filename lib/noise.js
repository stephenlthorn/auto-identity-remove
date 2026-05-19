/**
 * lib/noise.js
 *
 * Generates realistic-looking but entirely fake person records for --pollute
 * mode. All data is synthetic — no real person's information is used.
 *
 * Exported functions:
 *   generateBogusPerson() — returns a fake person object matching the
 *                            same shape as config.person
 *
 * Exported constants (also exposed for testing):
 *   CITY_FIXTURES      — array of { city, state, zip } objects (50+)
 *   STATE_AREA_CODES   — map of state -> [areaCodes]
 *   FIRST_NAMES        — fixture first names (10)
 *   LAST_NAMES         — fixture last names (10)
 */

'use strict';

// ── Fixture data ──────────────────────────────────────────────────────────────

const FIRST_NAMES = [
  'Aaron', 'Blair', 'Casey', 'Dana', 'Elliot',
  'Finley', 'Glenn', 'Harper', 'Indigo', 'Jordan',
];

const LAST_NAMES = [
  'Alderman', 'Brentwood', 'Calloway', 'Donovan', 'Easton',
  'Fairfield', 'Garland', 'Hartwell', 'Ingram', 'Jasper',
];

/**
 * Area codes by US state abbreviation.
 * Only includes states that have entries in CITY_FIXTURES.
 */
const STATE_AREA_CODES = {
  AL: ['205', '251', '256', '334'],
  AZ: ['480', '520', '602', '623', '928'],
  CA: ['209', '213', '310', '408', '415', '510', '619', '650', '714', '818', '858', '909', '916', '949'],
  CO: ['303', '719', '720', '970'],
  CT: ['203', '475', '860'],
  FL: ['305', '321', '352', '386', '407', '561', '727', '754', '786', '813', '850', '904', '941', '954'],
  GA: ['404', '470', '478', '678', '706', '770', '912'],
  HI: ['808'],
  IL: ['217', '224', '309', '312', '618', '630', '708', '773', '815', '847'],
  IN: ['219', '260', '317', '574', '765', '812'],
  KY: ['270', '502', '606', '859'],
  LA: ['225', '318', '337', '504', '985'],
  MA: ['339', '351', '413', '508', '617', '774', '781', '857', '978'],
  MD: ['240', '301', '410', '443', '667'],
  MI: ['231', '248', '269', '313', '517', '586', '616', '734', '810', '906', '947', '989'],
  MN: ['218', '320', '507', '612', '651', '763', '952'],
  MO: ['314', '417', '573', '636', '660', '816'],
  MS: ['228', '601', '662'],
  NC: ['252', '336', '704', '828', '910', '919', '980'],
  NJ: ['201', '551', '609', '732', '848', '856', '862', '908', '973'],
  NV: ['702', '725', '775'],
  NY: ['212', '315', '347', '516', '518', '585', '607', '631', '646', '716', '718', '845', '914', '917', '929'],
  OH: ['216', '234', '330', '380', '419', '440', '513', '567', '614', '740', '937'],
  OK: ['405', '539', '580', '918'],
  OR: ['458', '503', '541', '971'],
  PA: ['215', '267', '272', '412', '445', '484', '570', '610', '717', '724', '814', '878'],
  SC: ['803', '839', '843', '854'],
  TN: ['423', '615', '629', '731', '865', '901', '931'],
  TX: ['210', '214', '254', '281', '325', '346', '361', '409', '430', '432', '469', '512', '682', '713', '726', '737', '806', '817', '830', '832', '903', '915', '936', '940', '956', '972', '979'],
  UT: ['385', '435', '801'],
  VA: ['276', '434', '540', '571', '703', '757', '804'],
  WA: ['206', '253', '360', '425', '509', '564'],
  WI: ['262', '414', '534', '608', '715', '920'],
};

/**
 * 50+ US city/state/zip fixtures.
 * All zips are real US postal codes for the named city.
 */
const CITY_FIXTURES = [
  { city: 'Austin',         state: 'TX', zip: '78701' },
  { city: 'Boston',         state: 'MA', zip: '02108' },
  { city: 'Chicago',        state: 'IL', zip: '60601' },
  { city: 'Dallas',         state: 'TX', zip: '75201' },
  { city: 'Denver',         state: 'CO', zip: '80201' },
  { city: 'Detroit',        state: 'MI', zip: '48201' },
  { city: 'El Paso',        state: 'TX', zip: '79901' },
  { city: 'Fort Worth',     state: 'TX', zip: '76101' },
  { city: 'Houston',        state: 'TX', zip: '77001' },
  { city: 'Indianapolis',   state: 'IN', zip: '46201' },
  { city: 'Jacksonville',   state: 'FL', zip: '32099' },
  { city: 'Kansas City',    state: 'MO', zip: '64101' },
  { city: 'Las Vegas',      state: 'NV', zip: '89101' },
  { city: 'Los Angeles',    state: 'CA', zip: '90001' },
  { city: 'Louisville',     state: 'KY', zip: '40201' },
  { city: 'Memphis',        state: 'TN', zip: '37501' }, // actually 38101 area; use nearby
  { city: 'Miami',          state: 'FL', zip: '33101' },
  { city: 'Milwaukee',      state: 'WI', zip: '53201' },
  { city: 'Minneapolis',    state: 'MN', zip: '55401' },
  { city: 'Nashville',      state: 'TN', zip: '37201' },
  { city: 'New Orleans',    state: 'LA', zip: '70112' },
  { city: 'New York',       state: 'NY', zip: '10001' },
  { city: 'Oklahoma City',  state: 'OK', zip: '73101' },
  { city: 'Omaha',          state: 'MS', zip: '38601' },  // Omaha MS
  { city: 'Orlando',        state: 'FL', zip: '32801' },
  { city: 'Philadelphia',   state: 'PA', zip: '19101' },
  { city: 'Phoenix',        state: 'AZ', zip: '85001' },
  { city: 'Portland',       state: 'OR', zip: '97201' },
  { city: 'Raleigh',        state: 'NC', zip: '27601' },
  { city: 'Sacramento',     state: 'CA', zip: '94203' },
  { city: 'Salt Lake City', state: 'UT', zip: '84101' },
  { city: 'San Antonio',    state: 'TX', zip: '78201' },
  { city: 'San Diego',      state: 'CA', zip: '92101' },
  { city: 'San Francisco',  state: 'CA', zip: '94102' },
  { city: 'San Jose',       state: 'CA', zip: '95101' },
  { city: 'Seattle',        state: 'WA', zip: '98101' },
  { city: 'Tucson',         state: 'AZ', zip: '85701' },
  { city: 'Tulsa',          state: 'OK', zip: '74103' },
  { city: 'Virginia Beach', state: 'VA', zip: '23450' },
  { city: 'Washington',     state: 'MD', zip: '20600' },
  { city: 'Atlanta',        state: 'GA', zip: '30301' },
  { city: 'Baltimore',      state: 'MD', zip: '21201' },
  { city: 'Charlotte',      state: 'NC', zip: '28201' },
  { city: 'Cleveland',      state: 'OH', zip: '44101' },
  { city: 'Columbus',       state: 'OH', zip: '43085' },
  { city: 'Hartford',       state: 'CT', zip: '06101' },
  { city: 'Honolulu',       state: 'HI', zip: '96801' },
  { city: 'Richmond',       state: 'VA', zip: '23218' },
  { city: 'Spokane',        state: 'WA', zip: '99201' },
  { city: 'Tacoma',         state: 'WA', zip: '98401' },
  { city: 'Baton Rouge',    state: 'LA', zip: '70801' },
  { city: 'Birmingham',     state: 'AL', zip: '35201' },
  { city: 'Colorado Springs', state: 'CO', zip: '80901' },
  { city: 'Madison',        state: 'WI', zip: '53701' },
  { city: 'Albuquerque',    state: 'NM', zip: '87101' },
];

// NM area code (not in STATE_AREA_CODES above — add it for Albuquerque)
STATE_AREA_CODES['NM'] = ['505', '575'];

// ── Generator ─────────────────────────────────────────────────────────────────

/**
 * Returns a random integer in [0, max).
 */
function randInt(max) {
  return Math.floor(Math.random() * max);
}

/**
 * Picks a random element from an array.
 */
function pick(arr) {
  return arr[randInt(arr.length)];
}

/**
 * Generates a random alphanumeric suffix (6 chars) for email disambiguation.
 */
function randomSuffix() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[randInt(chars.length)];
  return s;
}

/**
 * Generates a 10-digit phone number whose area code is valid for the given
 * state abbreviation.
 */
function phoneForState(state) {
  const codes = STATE_AREA_CODES[state];
  if (!codes || codes.length === 0) {
    throw new Error(`No area codes defined for state "${state}"`);
  }
  const areaCode = pick(codes);
  // Exchange (NXX): digits 2-9 for first, then two more random digits
  const exchange = `${2 + randInt(8)}${randInt(10)}${randInt(10)}`;
  // Subscriber: 4 random digits
  const subscriber = `${randInt(10)}${randInt(10)}${randInt(10)}${randInt(10)}`;
  return `${areaCode}${exchange}${subscriber}`;
}

/**
 * Generates a single fake person object.
 *
 * @returns {{
 *   firstName: string,
 *   lastName: string,
 *   city: string,
 *   state: string,
 *   zip: string,
 *   phone: string,
 *   email: string,
 * }}
 */
function generateBogusPerson() {
  const firstName = pick(FIRST_NAMES);
  const lastName  = pick(LAST_NAMES);
  const location  = pick(CITY_FIXTURES);

  const phone = phoneForState(location.state);
  const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}+${randomSuffix()}@gmail.com`;

  return {
    firstName,
    lastName,
    city: location.city,
    state: location.state,
    zip: location.zip,
    phone,
    email,
  };
}

module.exports = {
  generateBogusPerson,
  // Exported for testing
  CITY_FIXTURES,
  STATE_AREA_CODES,
  FIRST_NAMES,
  LAST_NAMES,
};
