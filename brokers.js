/**
 * brokers.js - data broker opt-out definitions
 *
 * Each entry describes one broker and HOW to automate its opt-out.
 *
 * method:
 *   'search-form'  - search for the person, extract listing URL, submit opt-out
 *   'direct-form'  - go straight to the opt-out URL and fill the form
 *   'email'        - send a removal-request email
 *   'manual'       - too complex to automate; added to the printed manual list
 *
 * captchaLikely    - true = pre-attempt CapSolver before submit
 * priority         - 1 = highest (most commonly searched / highest risk)
 * timeoutMs        - optional per-broker navigation timeout in ms (default: 15000)
 * searchNeeds      - the person fields (firstName, lastName, fullName, state) the searchUrl is
 *                    built from. `aidr scan` will not search when one is blank: a URL with an
 *                    empty name or state does not look for the person, so its "no listing"
 *                    would say nothing about them (S1)
 * searchCheckedAt  - the day the search step was validated live, in BOTH directions (finds a
 *                    real listing, and reads "not listed" on a real empty page). Only a broker
 *                    with it may make `--found-only` skip a broker as "not listed" (S8)
 *
 * No personal info lives here - all values come from config.json at runtime.
 */

const _fs = require('fs');

let _cachedConfig = null;
function _getConfig() {
  if (_cachedConfig) return _cachedConfig;

  // Go through lib/config.js loadConfig() so an encrypted config works. A bare
  // require('./config.json') returns nothing once --encrypt-config has moved the
  // PII into config.json.enc, which used to blank every value interpolated below
  // and silently disable the whole browser opt-out path.
  //
  // loadConfig() calls process.exit(1) when no config exists at all, so only
  // call it once a config file is actually present: requiring this module must
  // stay safe on a fresh clone (setup, --list, the test suite).
  try {
    const { loadConfig, CONFIG_PATH, CONFIG_ENC_PATH } = require('./lib/config');
    if (_fs.existsSync(CONFIG_ENC_PATH) || _fs.existsSync(CONFIG_PATH)) {
      _cachedConfig = loadConfig();
      return _cachedConfig;
    }
  } catch (_) {
    // Missing lib/, unreadable envelope, or no passphrase. watcher.js reports
    // the real error on its own loadConfig() call; fall through so requiring
    // broker metadata never throws.
  }

  try {
    _cachedConfig = require('./config.json');
  } catch (_) {
    _cachedConfig = { person: {}, persons: [], email: {} };
  }
  return _cachedConfig;
}

const config = new Proxy({}, {
  get(_, prop) { return _getConfig()[prop]; },
});

/**
 * The person whose values the default export is built from.
 *
 * `config.person` is the historical single-person key. `config.persons` is the
 * multi-person format that lib/config.js getPersonsFromConfig() prefers; a
 * config using only `persons` has no `config.person`, so without this fallback
 * every interpolated value below became `undefined` - search URLs read
 * "?q=undefined" and every formFields value was undefined.
 */
function _primaryPerson() {
  const cfg = _getConfig();
  // persons[] wins when both keys exist, exactly like getPersonsFromConfig() in
  // lib/config.js. The dashboard's Config tab writes a blank `person` onto a
  // persons[] config when it saves, and the old person-first order then built
  // every search URL from an empty name ("search?q=&type=pp"), which a
  // --verify run reads as "verified clear" for every broker.
  if (Array.isArray(cfg.persons) && cfg.persons.length > 0 && _isPersonObject(cfg.persons[0])) {
    return cfg.persons[0];
  }
  if (_isPersonObject(cfg.person) && !_isBlankPerson(cfg.person)) return cfg.person;
  return {};
}

function _isPersonObject(p) {
  return p !== null && typeof p === 'object' && !Array.isArray(p);
}

// A person whose every value is empty carries no identity. Treat it as absent.
function _isBlankPerson(p) {
  return Object.values(p).every(v => v == null || String(v).trim() === '');
}

// US state code or name -> the lower-case, hyphenated slug some people-search
// sites put in their search URL (CA -> "california", New York -> "new-york"),
// plus a name slug for the same URLs. Only the fifty states are listed: a value
// that is not one of them has no slug, so a broker whose search URL needs one is
// simply not searchable for that person (a Canadian province or a typo must never
// become a guessed URL). These live here, not in lib/, because several tests load
// a lone copy of this file beside a synthetic config.json.
const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const hyphenate = (name) => name.toLowerCase().replace(/\s+/g, '-');

const SLUG_BY_KEY = new Map();
for (const [code, name] of Object.entries(STATE_NAMES)) {
  SLUG_BY_KEY.set(code.toLowerCase(), hyphenate(name));
  SLUG_BY_KEY.set(name.toLowerCase(), hyphenate(name));
}

/** The state slug for a two-letter code or a full name, or '' when it is not a US state. */
function stateSlug(value) {
  if (value == null) return '';
  const key = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  return SLUG_BY_KEY.get(key) || '';
}

/** "Mary Ann O'Neil" -> "mary-ann-oneil": lower-case, spaces to hyphens, only a-z 0-9 and hyphen kept. */
function nameSlug(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

// Never interpolate the literal string "undefined" into a URL or a form value.
// A missing field becomes empty, which fails a lookup honestly (notFound)
// instead of searching brokers for a person named "undefined".
const enc = s => encodeURIComponent(s == null ? '' : s);

// A bare input[name*="name" i] also matches firstname, lastname, company_name,
// username and nickname, and fillForm takes the first match, so the person's
// full name could land in a company or username box (BRK-8). These are the
// words that make a "*name*" field somebody else's name or not a person's name.
// :not() is evaluated per attribute, so the placeholder variant excludes
// "Last name" / "Company name" placeholders the same way.
const NOT_A_FULL_NAME = [
  'first', 'last', 'fname', 'lname', 'surname', 'family', 'given', 'middle',
  'user', 'nick', 'company', 'business', 'organi', 'file', 'maiden',
];
const fullNameInput = (attr) =>
  `input[${attr}*="name" i]${NOT_A_FULL_NAME.map(w => `:not([${attr}*="${w}" i])`).join('')}`;

/**
 * Split a phone number into the two shapes phone-lookup sites ask for.
 *
 *   national - 10 digits, for US forms whose country picker defaults to +1
 *   e164     - "+<country code><number>", for caller-ID apps that want the
 *              country code typed in
 *
 * Either is '' when it cannot be derived honestly: a non-US/CA number written
 * without a leading "+" has no knowable country code, so it is not guessed.
 *
 * @param {string} [phone]
 * @param {string} [country]  ISO 3166-1 alpha-2, default 'US'
 * @returns {{ national: string, e164: string }}
 */
function phoneParts(phone, country) {
  const raw = phone == null ? '' : String(phone).trim();
  const digits = raw.replace(/\D/g, '');
  const nanp = ['US', 'CA'].includes(String(country || 'US').toUpperCase());

  if (nanp && digits.length === 10) return { national: digits, e164: `+1${digits}` };
  if (nanp && digits.length === 11 && digits[0] === '1') {
    return { national: digits.slice(1), e164: `+${digits}` };
  }
  if (raw.startsWith('+') && digits.length >= 8) return { national: '', e164: `+${digits}` };
  return { national: '', e164: '' };
}

/**
 * Build the broker list for one person.
 *
 * These values must be resolved per person, not once at module load: watcher.js
 * loops `for (const person of persons)` and each iteration needs that person's
 * own name, city, state, zip and email in the search URLs and form fields.
 * Baking them once meant person B's run submitted person A's PII to the broker.
 *
 * @param {object} [person]  defaults to _primaryPerson()
 * @returns {object[]} a fresh array of fresh broker objects
 */
function buildBrokers(person) {
  const p = person || _primaryPerson();
  // Coerce missing fields to '' up front. Not every interpolation site below
  // goes through enc(), so this is what guarantees no template ever renders the
  // literal string "undefined" into a broker URL or form value.
  const s = (v) => (v == null ? '' : String(v));
  const F = s(p.firstName), L = s(p.lastName), N = s(p.fullName);
  const ST = s(p.state), C = s(p.city), E = s(p.email), Z = s(p.zip);
  const { national: PN, e164: PE } = phoneParts(p.phone, p.country);
  // Phone-keyed forms cannot do anything without the number, so a person
  // without one gets a logged skip instead of an empty submission every month.
  const needsPN = PN ? undefined : 'no US phone number in config.json (person.phone)';
  const needsPE = PE ? undefined : 'no phone number with a country code in config.json (e.g. +44 20 7946 0000)';

  // USPhonebook's search page is /<first>-<last>/<state-slug>. Without a usable
  // name or a US state there is no honest URL to build, so none of the four
  // search fields is set and canSearch() (lib/searchable.js) says no.
  const nameSlugs = nameSlug(F) && nameSlug(L) ? `${nameSlug(F)}-${nameSlug(L)}` : '';
  const stateSlugValue = stateSlug(ST);
  const usphonebookSearch = nameSlugs && stateSlugValue ? {
    searchUrl: `https://www.usphonebook.com/${nameSlugs}/${stateSlugValue}`,
    listingPattern: /usphonebook\.com\/[a-z0-9-]+\/U[A-Za-z0-9]{15,}/i,
    lastName: L,
    searchNeeds: ['firstName', 'lastName', 'state'],
    searchNotFound: { status: 404, text: /0 Public Records Found/i },
    searchCheckedAt: '2026-11-17',
  } : {};

  return [

  // ═══ Priority 1 - High-traffic people-search sites ═══════════════════════

  {
    name: 'Spokeo',
    method: 'search-form',
    searchUrl: `https://www.spokeo.com/search?q=${enc(N)}&type=pp&state=${ST}`,
    listingPattern: /spokeo\.com\/[^/]+\/[^/]+\/[^/]+-p\d+/i,
    searchNeeds: ['fullName', 'state'],
    lastName: L,
    optOutUrl: 'https://www.spokeo.com/optout',
    formFields: { 'input[name="email"]': E },
    submitSelector: 'button[type="submit"],input[type="submit"]',
    captchaLikely: false,
    priority: 1,
    usOnly: true,
    expectedSender: 'optout@spokeo.com',
  },

  {
    name: 'WhitePages',
    method: 'search-form',
    searchUrl: `https://www.whitepages.com/name/${enc(F)}-${enc(L)}/${ST}`,
    listingPattern: /whitepages\.com\/people\//i,
    searchNeeds: ['firstName', 'lastName', 'state'],
    lastName: L,
    optOutUrl: 'https://www.whitepages.com/suppression-requests',
    formFields: { 'input[name="name"]': N, 'input[name="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
    usOnly: true,
    expectedSender: 'noreply@whitepages.com',
  },

  {
    name: 'FastPeopleSearch',
    method: 'search-form',
    searchUrl: `https://www.fastpeoplesearch.com/name/${enc(F)}-${enc(L)}_${ST}`,
    listingPattern: /fastpeoplesearch\.com\/name\//i,
    searchNeeds: ['firstName', 'lastName', 'state'],
    lastName: L,
    optOutUrl: 'https://www.fastpeoplesearch.com/optout',
    formFields: { [`input[id="optout_name"],${fullNameInput('name')}`]: N, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
    usOnly: true,
  },

  {
    name: 'TruePeopleSearch',
    method: 'direct-form',
    optOutUrl: 'https://www.truepeoplesearch.com/removal',
    formFields: { [`${fullNameInput('name')},${fullNameInput('placeholder')}`]: N, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
    usOnly: true,
    expectedSender: 'noreply@truepeoplesearch.com',
  },

  {
    // direct-form since BRK-9. This entry used to be search-form with
    // listingPattern /beenverified\.com/, which matches the site's own logo and
    // nav links, so the "listing" it found was always the homepage and --verify
    // could never report anything but "still listed". Its searchUrl was also the
    // opt-out search FORM, a page with no person-specific links, so a tighter
    // pattern alone would have turned that into "never listed" (opt-out skipped,
    // --verify "verified clear"). The page is the form: fill it, nothing to look
    // up first, and --verify reports it unverifiable instead of guessing.
    name: 'BeenVerified',
    method: 'direct-form',
    optOutUrl: 'https://www.beenverified.com/app/optout/search',
    formFields: { 'input[name="firstName"]': F, 'input[name="lastName"]': L, 'select[name="state"]': ST },
    submitSelector: 'button[type="submit"]',
    captchaLikely: true,
    priority: 1,
    usOnly: true,
    expectedSender: 'noreply@beenverified.com',
  },

  // Radaris removed 2026-11-17: radaris.com was transferred by court order to
  // Atlas Data Privacy Corporation. Every URL on the domain, including search
  // URLs, now answers HTTP 200 with the same "This Domain Has Been Transferred
  // by Court Order" notice, and the opt-out pages no longer exist. Confirmed
  // 2026-11-17. The old search step read that notice as an empty results page,
  // so it would have recorded every person as clear. radaris.com is kept in
  // data/dead-urls.json so the generic runner never visits it either.

  {
    name: 'Intelius',
    method: 'direct-form',
    optOutUrl: 'https://www.intelius.com/optout',
    formFields: { 'input[name="firstName"]': F, 'input[name="lastName"]': L, 'input[type="email"]': E, 'select[name="state"]': ST },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
    expectedSender: 'privacy@intelius.com',
  },

  {
    name: 'PeopleFinders',
    method: 'direct-form',
    optOutUrl: 'https://www.peoplefinders.com/opt-out',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E, 'input[name*="state" i]': ST },
    submitSelector: 'button[type="submit"],input[type="submit"]',
    captchaLikely: false,
    priority: 1,
    expectedSender: 'support@peoplefinders.com',
  },

  {
    name: 'PeopleSmart',
    method: 'direct-form',
    optOutUrl: 'https://www.peoplesmart.com/optout-go',
    formFields: { 'input[name="firstName"]': F, 'input[name="lastName"]': L, 'input[type="email"]': E, 'select[name="state"]': ST },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
  },

  {
    name: 'MyLife',
    method: 'search-form',
    searchUrl: `https://www.mylife.com/find-people/results.pubview?searchtype=PEOPLE&firstname=${enc(F)}&lastname=${enc(L)}&state=${ST}`,
    listingPattern: /mylife\.com\/[^/]+\/[^/]+-\d+\.html/i,
    searchNeeds: ['firstName', 'lastName', 'state'],
    lastName: L,
    optOutUrl: 'https://www.mylife.com/privacy-policy/',
    formFields: { 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: true,
    priority: 1,
    expectedSender: 'support@mylife.com',
  },

  {
    name: 'Nuwber',
    method: 'search-form',
    searchUrl: `https://nuwber.com/person/search?name=${enc(N)}&state=${ST}`,
    listingPattern: /nuwber\.com\/person\//i,
    searchNeeds: ['fullName', 'state'],
    lastName: L,
    optOutUrl: 'https://nuwber.com/removal/link',
    formFields: { 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
  },

  {
    name: 'FamilyTreeNow',
    method: 'direct-form',
    optOutUrl: 'https://www.familytreenow.com/optout',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: true,
    priority: 1,
    expectedSender: 'noreply@familytreenow.com',
  },

  {
    name: 'CheckPeople',
    method: 'direct-form',
    // Their /opt-out page redirects - use the search-based removal flow instead
    optOutUrl: `https://checkpeople.com/opt-out?firstName=${enc(F)}&lastName=${enc(L)}&state=${ST}`,
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E, 'select[name*="state" i]': ST },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  // ═══ Priority 2 - Additional people-search sites ══════════════════════════

  {
    name: 'ThatsThem',
    method: 'direct-form',
    optOutUrl: 'https://thatsthem.com/optout',
    formFields: { [fullNameInput('name')]: N, 'input[name*="email" i]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
    // No SSN/DOB gate - safe to submit arbitrary name/email for noise mode
    acceptsBogus: true,
  },

  {
    name: 'USPhonebook',
    method: 'direct-form',
    // Search step, so `aidr scan` and `aidr verify` can tell whether the person
    // is listed. Validated live 2026-11-17 in both directions: "John Smith" in
    // California gave 200 with 86 person links, a nonsense name gave HTTP 404
    // with "0 Public Records Found". That 404 is the site's real "no results"
    // answer, so it is stated in searchNotFound; any other non-2xx stays
    // "could not tell". The method stays direct-form, so the opt-out below is
    // unchanged. The search URL needs a US state slug: a person whose state is
    // not one gets no search step at all and simply cannot be searched.
    ...usphonebookSearch,
    // /opt-out redirects here. The page also carries name and phone SEARCH
    // boxes, so the selectors name the removal form's own fields.
    optOutUrl: 'https://www.usphonebook.com/removal',
    formFields: {
      '#subject-firstname': F,
      '#subject-lastname': L,
      '#subject-email': E,
      '#agreement': 'yes',
    },
    submitSelector: '#BRP',
    captchaLikely: true,
    priority: 2,
    usOnly: true,
  },

  // PublicDataUSA removed 2026-10-23: domain no longer resolves
  // (getaddrinfo EAI_AGAIN), and its twin site usa-official.com is also down.
  // Multiple independent sources confirm the site was shut down around
  // September 2026. Per the convention above ("Remove from brokers.js if
  // site is gone"), there's no live site left to opt out of.

  {
    name: 'SmartBackgroundChecks',
    method: 'direct-form',
    optOutUrl: 'https://www.smartbackgroundchecks.com/optout',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E, 'select[name*="state" i]': ST },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  {
    name: 'SearchPeopleFree',
    method: 'direct-form',
    optOutUrl: 'https://www.searchpeoplefree.com/opt-out',
    formFields: { [fullNameInput('name')]: N, 'input[name*="email" i]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
    // No SSN/DOB gate - safe to submit arbitrary name/email for noise mode
    acceptsBogus: true,
  },

  {
    name: 'PeopleSearchNow',
    method: 'direct-form',
    optOutUrl: 'https://www.peoplesearchnow.com/opt-out',
    formFields: { [fullNameInput('name')]: N, 'input[name*="email" i]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
    // No SSN/DOB gate - safe to submit arbitrary name/email for noise mode
    acceptsBogus: true,
  },

  {
    name: 'InfoTracer',
    method: 'direct-form',
    optOutUrl: 'https://infotracer.com/optout/',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
    // No SSN/DOB gate - safe to submit arbitrary name/email for noise mode
    acceptsBogus: true,
  },

  {
    name: 'SocialCatfish',
    method: 'direct-form',
    optOutUrl: 'https://socialcatfish.com/opt-out/',
    formFields: { [fullNameInput('name')]: N, 'input[name*="email" i]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  {
    name: 'NationalPublicData',
    method: 'direct-form',
    optOutUrl: 'https://nationalpublicdata.com/optout.html',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  // ClustrMaps removed 2026-10-23: clustrmaps.com and www. resolve to
  // 127.0.0.1 from ClustrMaps' own nameservers (srv53), confirmed via
  // Cloudflare and Google DNS-over-HTTPS too, so no browser anywhere can
  // reach it. The SOA serial dates the change to about 2026-09-21. The
  // domain is still registered (to 2027-06), so it may come back - re-add
  // this entry if it does, and drop clustrmaps.com from data/dead-urls.json
  // (added so the generic runner's BADBOOL copy stops retrying it).

  {
    name: 'PrivateRecords',
    method: 'direct-form',
    optOutUrl: 'https://www.privaterecords.net/api/helper/optOutLight/search',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  // ═══ Priority 1 - Major upstream aggregators ══════════════════════════════
  // These feed many smaller sites - highest leverage opt-outs

  {
    name: 'Acxiom',
    method: 'direct-form',
    optOutUrl: 'https://isapps.acxiom.com/optout/optout.aspx',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E, 'input[name*="zip" i]': Z },
    submitSelector: 'input[type="submit"],button[type="submit"]',
    captchaLikely: false,
    priority: 1,
  },

  {
    name: 'LexisNexis',
    method: 'direct-form',
    optOutUrl: 'https://optout.lexisnexis.com/',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E, 'input[name*="zip" i]': Z },
    submitSelector: 'button[type="submit"],input[type="submit"]',
    captchaLikely: false,
    priority: 1,
  },

  {
    // Manual since 2026-10-23: the removal page sits behind a HUMAN
    // (PerimeterX) "Press & Hold" bot challenge - checked live, it returns
    // 403 to an automated browser before any form renders. The old
    // /update-my-info page is a 404.
    name: 'ZoomInfo',
    method: 'manual',
    optOutUrl: 'https://privacyrequest.zoominfo.com/remove/verify',
    notes: 'Open https://privacyrequest.zoominfo.com/remove/verify, pass the "Press & Hold" check, then follow the email verification to request removal.',
    priority: 1,
  },

  {
    // Manual since 2026-10-23. Clearbit is now HubSpot's "Breeze
    // Intelligence"; requests go through a DataGrail Privacy Request Center
    // (old clearbit.com/privacy/opt-out is a 404). Checked live, the deletion
    // form at /form/deletion?locationCode=US-<ST> has first_name, last_name
    // and email_address inputs, but direct-form cannot finish it: the
    // required "relationship" field is a MUI select with a hidden input that
    // fillForm cannot set, and "Review Request" leads to a second confirm
    // step, so a single submit click would be reported for a request that
    // was never sent.
    name: 'Clearbit',
    method: 'manual',
    optOutUrl: 'https://preferences.clearbit.com',
    notes: 'Open https://preferences.clearbit.com, choose your country and state, then "Start Deletion Request". Pick "Myself", fill name and email, set relationship (usually "Other"), then Review Request and confirm.',
    priority: 1,
  },

  {
    // Manual since 2026-10-24. Andrews Wharton ("A Stirista Solution") came in
    // from the Markup dataset, and its homepage has a marketing sign-up form.
    // The generic runner filled and submitted it, logged "Form submitted" as
    // an opt-out, and the user got a "Confirm your subscription" email
    // instead. Listing it here with the homepage as optOutUrl dedupes the
    // generic entry by host so the runner never submits that form again; the
    // real opt-out is Stirista's portal.
    name: 'Andrews Wharton',
    method: 'manual',
    optOutUrl: 'https://www.andrewswharton.com/',
    notes: 'Do not use the sign-up form on andrewswharton.com, and do not click any "Confirm your subscription" email from it. Andrews Wharton is part of Stirista: opt out at https://unsubscribe.stirista.com/ or email privacy@stirista.com with your name, email and current and prior addresses.',
    priority: 3,
  },

  // ═══ Additional people-search / data broker sites ════════════════════════

  // PeekYou removed 2026-11-17: peekyou.com was transferred by court order to
  // Atlas Data Privacy Corporation, together with radaris.com, and now shows a
  // "Domain Update" notice; the opt-out page no longer exists. Confirmed
  // 2026-11-17. peekyou.com is kept in data/dead-urls.json so the generic runner
  // never visits it.

  {
    name: 'Addresses.com',
    method: 'direct-form',
    optOutUrl: 'https://www.addresses.com/optout.php',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"],input[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  {
    name: 'AnyWho',
    method: 'direct-form',
    optOutUrl: 'https://www.anywho.com/optout',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"],input[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  {
    name: 'TruthFinder',
    method: 'direct-form',
    optOutUrl: 'https://www.truthfinder.com/opt-out/',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[name*="state" i]': ST },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
  },

  {
    name: 'InstantCheckmate',
    method: 'direct-form',
    optOutUrl: 'https://www.instantcheckmate.com/opt-out/',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[name*="state" i]': ST },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
    expectedSender: 'noreply@instantcheckmate.com',
  },

  {
    name: 'Spokeo (email)',
    method: 'email',
    emailTo: 'privacy@spokeo.com',
    priority: 2,
  },

  {
    // URL updated 2026-10-23: old /privacy/data-subject-rights-request
    // returned 404. Confirmed-live replacement is legal.epsilon.com/dsr/.
    name: 'Epsilon',
    method: 'direct-form',
    optOutUrl: 'https://legal.epsilon.com/dsr/',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  {
    name: 'Oracle Data Cloud',
    method: 'direct-form',
    optOutUrl: 'https://datacloudoptout.oracle.com/',
    formFields: { 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  {
    // URL updated 2026-10-23: old /privacy/opt-out/ returned 404. Confirmed
    // replacement is the "Your Privacy Choices" (sale/sharing opt-out) link
    // on equifax.com - distinct from optoutprescreen.com, which is the
    // separate prescreened-credit-offer opt-out already listed elsewhere.
    name: 'Equifax (marketing)',
    method: 'direct-form',
    optOutUrl: 'https://myprivacy.equifax.com/opt-in-opt-out/personal-info/',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E, 'input[name*="zip" i]': Z },
    submitSelector: 'button[type="submit"],input[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  {
    name: 'Experian (marketing)',
    method: 'direct-form',
    optOutUrl: 'https://www.experian.com/privacy/opting_out.html',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[name*="city" i]': C, 'input[name*="zip" i]': Z },
    submitSelector: 'button[type="submit"],input[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  {
    name: 'DataAxle',
    method: 'direct-form',
    optOutUrl: 'https://www.data-axle.com/privacy-policy/#optout',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E, 'input[name*="zip" i]': Z },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  // ═══ Phone numbers - caller-ID apps, reverse phone lookups, Do Not Call ═══
  // These are keyed by the phone number, not the name. Caller-ID apps build
  // their directories from uploaded contact books, and reverse-lookup sites are
  // where call lists get a name for a number.

  {
    // After the reCAPTCHA, Truecaller asks you to prove you own the number by
    // sending an SMS or WhatsApp message from it, which no script can do.
    name: 'Truecaller',
    method: 'manual',
    optOutUrl: 'https://www.truecaller.com/unlisting',
    priority: 1,
    notes: 'Click "No, I want to unlist", enter your number with its country code (e.g. +15125550000), solve the reCAPTCHA, then send the SMS or WhatsApp message it shows from that phone. Unlisting cannot be undone and takes up to 24 hours.',
  },

  {
    name: 'Sync.ME',
    method: 'direct-form',
    optOutUrl: 'https://sync.me/unsubscribe/',
    // A modal cookie <dialog> makes the form inert until it is dismissed.
    // Its Turnstile passes on its own in a headed browser (token within ~3s)
    // but never headless, where the site answers "reCAPTCHA is required".
    preClickSelector: 'dialog[open] button:has-text("Accept All Cookies")',
    formFields: { '#name': N, '#email': E, '#phoneNumber': PN },
    submitSelector: 'button[type="submit"]:has-text("Send")',
    captchaLikely: true,
    priority: 1,
    // The country picker defaults to +1 and is not driven yet.
    usOnly: true,
    skipReason: needsPN,
  },

  {
    name: 'CallApp',
    method: 'direct-form',
    optOutUrl: 'https://callapp.com/how-to/unlist-phone-number',
    formFields: { 'input[name="phone"]': PE, 'input[name="email"]': E },
    submitSelector: 'button[type="submit"]:has-text("Send")',
    captchaLikely: false,
    priority: 2,
    skipReason: needsPE,
  },

  {
    name: 'NumLookup',
    method: 'direct-form',
    optOutUrl: 'https://www.numlookup.com/opt_out',
    formFields: { 'input[name="optout_number"]': PN },
    submitSelector: 'input[type="submit"]',
    captchaLikely: false,
    priority: 2,
    // The country <select> defaults to USA and is not driven yet.
    usOnly: true,
    skipReason: needsPN,
  },

  {
    // Hiya supplies caller ID to Samsung phones and several US carriers.
    name: 'Hiya',
    method: 'email',
    emailTo: 'DPO@hiya.com',
    emailSubjectPrefix: 'Advanced Data Management',
    priority: 1,
  },

  {
    // Eyecon's privacy policy (Annex B) gives this address for removing a
    // number from its search database.
    name: 'Eyecon',
    method: 'email',
    emailTo: 'privacy@instabridge.com',
    priority: 2,
  },

  {
    name: 'National Do Not Call Registry',
    method: 'manual',
    optOutUrl: 'https://www.donotcall.gov/register.html',
    priority: 1,
    usOnly: true,
    notes: 'One-time and free: registrations never expire. Click "Register Your Phone", enter the number and your email, Submit, then Register. Click the link in the email from Register@donotcall.gov within 72 hours. Stops legitimate telemarketers, not scammers. Once registered, add this entry to your allowlist so it stops reopening.',
  },

  {
    name: 'Spy Dialer',
    method: 'manual',
    optOutUrl: 'https://www.spydialer.com/consumers/wizards.aspx',
    priority: 2,
    usOnly: true,
    notes: 'Multi-step wizard (state first, then the number) behind reCAPTCHA Enterprise.',
  },

  // ═══ Email-based opt-outs ═════════════════════════════════════════════════

  {
    name: 'Pipl',
    method: 'email',
    emailTo: 'privacy@pipl.com',
    priority: 2,
  },

  // ═══ Manual-only (requires human interaction) ═════════════════════════════

  {
    name: 'Google - Results About You',
    method: 'manual',
    optOutUrl: 'https://myaccount.google.com/data-and-privacy',
    notes: 'Use "Results about you" to flag address/phone in search results.',
    priority: 1,
  },

  {
    name: 'Google - Outdated Content',
    method: 'manual',
    optOutUrl: 'https://search.google.com/search-console/remove-outdated-content',
    notes: 'Submit if any cached pages show your personal info.',
    priority: 3,
  },

  // California's DROP (Delete Request and Opt-out Platform), run by the California Privacy
  // Protection Agency. Open to consumers since 2026-01-01; registered brokers have had to
  // process it since 2026-08-01. The state verifies residency, so this stays manual: the
  // person submits it, then records the date with `aidr drop --done` (lib/drop.js).
  // californiaOnly: watcher.js shows it only to people whose state is California.
  {
    name: 'CalPrivacy DROP',
    method: 'manual',
    optOutUrl: 'https://consumer.drop.privacy.ca.gov',
    californiaOnly: true,
    notes: 'California residents: one request covers every broker on the state registry, and brokers must delete within 45 days of picking it up (up to 90 days in all). Open to consumers since 2026-01-01; brokers have processed it since 2026-08-01. Submit it at consumer.drop.privacy.ca.gov, then run: aidr drop --done',
    priority: 1,
  },

  ];
}

// Default export stays an array so every existing `require('./brokers')` call
// site keeps working unchanged. `.forPerson(person)` is the per-person build
// used by watcher.js inside its persons loop.
const brokers = buildBrokers();
brokers.forPerson = buildBrokers;
brokers.stateSlug = stateSlug;
brokers.nameSlug = nameSlug;

module.exports = brokers;
