/**
 * brokers.js — data broker opt-out definitions
 *
 * Each entry describes one broker and HOW to automate its opt-out.
 *
 * method:
 *   'search-form'  — search for the person, extract listing URL, submit opt-out
 *   'direct-form'  — go straight to the opt-out URL and fill the form
 *   'email'        — send a removal-request email
 *   'manual'       — too complex to automate; added to the printed manual list
 *
 * captchaLikely    — true = pre-attempt CapSolver before submit
 * priority         — 1 = highest (most commonly searched / highest risk)
 *
 * No personal info lives here — all values come from config.json at runtime.
 */

const config  = require('./config.json');
const { firstName: F, lastName: L, fullName: N, state: ST, city: C, email: E, zip: Z } = config.person;
const enc = s => encodeURIComponent(s);

module.exports = [

  // ═══ Priority 1 — High-traffic people-search sites ═══════════════════════

  {
    name: 'Spokeo',
    method: 'search-form',
    searchUrl: `https://www.spokeo.com/search?q=${enc(N)}&type=pp&state=${ST}`,
    listingPattern: /spokeo\.com\/[^/]+\/[^/]+\/[^/]+-p\d+/i,
    optOutUrl: 'https://www.spokeo.com/optout',
    formFields: { 'input[name="email"]': E },
    submitSelector: 'button[type="submit"],input[type="submit"]',
    captchaLikely: false,
    priority: 1,
    usOnly: true,
  },

  {
    name: 'WhitePages',
    method: 'search-form',
    searchUrl: `https://www.whitepages.com/name/${enc(F)}-${enc(L)}/${ST}`,
    listingPattern: /whitepages\.com\/people\//i,
    optOutUrl: 'https://www.whitepages.com/suppression-requests',
    formFields: { 'input[name="name"]': N, 'input[name="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
    usOnly: true,
  },

  {
    name: 'FastPeopleSearch',
    method: 'search-form',
    searchUrl: `https://www.fastpeoplesearch.com/name/${enc(F)}-${enc(L)}_${ST}`,
    listingPattern: /fastpeoplesearch\.com\/name\//i,
    optOutUrl: 'https://www.fastpeoplesearch.com/optout',
    formFields: { 'input[id="optout_name"],input[name*="name"]': N, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
    usOnly: true,
  },

  {
    name: 'TruePeopleSearch',
    method: 'direct-form',
    optOutUrl: 'https://www.truepeoplesearch.com/removal',
    formFields: { 'input[name*="name"],input[placeholder*="name" i]': N, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
    usOnly: true,
  },

  {
    name: 'BeenVerified',
    method: 'search-form',
    searchUrl: 'https://www.beenverified.com/app/optout/search',
    listingPattern: /beenverified\.com/i,
    optOutUrl: 'https://www.beenverified.com/app/optout/search',
    formFields: { 'input[name="firstName"]': F, 'input[name="lastName"]': L, 'select[name="state"]': ST },
    submitSelector: 'button[type="submit"]',
    captchaLikely: true,
    priority: 1,
    usOnly: true,
  },

  {
    name: 'Radaris',
    method: 'search-form',
    searchUrl: `https://radaris.com/p/${enc(F)}/${enc(L)}/`,
    listingPattern: /radaris\.com\/p\//i,
    optOutUrl: 'https://radaris.com/control/privacy',
    formFields: { 'input[name*="first"],input[placeholder*="first" i]': F, 'input[name*="last"],input[placeholder*="last" i]': L, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
  },

  {
    name: 'Intelius',
    method: 'direct-form',
    optOutUrl: 'https://www.intelius.com/optout',
    formFields: { 'input[name="firstName"]': F, 'input[name="lastName"]': L, 'input[type="email"]': E, 'select[name="state"]': ST },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
  },

  {
    name: 'PeopleFinders',
    method: 'direct-form',
    optOutUrl: 'https://www.peoplefinders.com/opt-out',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E, 'input[name*="state" i]': ST },
    submitSelector: 'button[type="submit"],input[type="submit"]',
    captchaLikely: false,
    priority: 1,
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
    optOutUrl: 'https://www.mylife.com/privacy-policy/',
    formFields: { 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: true,
    priority: 1,
  },

  {
    name: 'Nuwber',
    method: 'search-form',
    searchUrl: `https://nuwber.com/person/search?name=${enc(N)}&state=${ST}`,
    listingPattern: /nuwber\.com\/person\//i,
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
  },

  {
    name: 'CheckPeople',
    method: 'direct-form',
    // Their /opt-out page redirects — use the search-based removal flow instead
    optOutUrl: `https://checkpeople.com/opt-out?firstName=${enc(F)}&lastName=${enc(L)}&state=${ST}`,
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E, 'select[name*="state" i]': ST },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  // ═══ Priority 2 — Additional people-search sites ══════════════════════════

  {
    name: 'ThatsThem',
    method: 'direct-form',
    optOutUrl: 'https://thatsthem.com/optout',
    formFields: { 'input[name*="name" i]': N, 'input[name*="email" i]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
    // No SSN/DOB gate — safe to submit arbitrary name/email for noise mode
    acceptsBogus: true,
  },

  {
    name: 'USPhonebook',
    method: 'direct-form',
    optOutUrl: 'https://www.usphonebook.com/opt-out',
    formFields: { 'input[name*="name" i]': N, 'input[name*="email" i]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
    usOnly: true,
  },

  {
    name: 'PublicDataUSA',
    method: 'direct-form',
    optOutUrl: 'https://www.publicdatausa.com/remove.php',
    formFields: { 'input[name*="name" i]': N, 'input[name*="email" i]': E, 'input[name*="state" i]': ST },
    submitSelector: 'input[type="submit"],button[type="submit"]',
    captchaLikely: false,
    priority: 2,
    usOnly: true,
  },

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
    formFields: { 'input[name*="name" i]': N, 'input[name*="email" i]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
    // No SSN/DOB gate — safe to submit arbitrary name/email for noise mode
    acceptsBogus: true,
  },

  {
    name: 'PeopleSearchNow',
    method: 'direct-form',
    optOutUrl: 'https://www.peoplesearchnow.com/opt-out',
    formFields: { 'input[name*="name" i]': N, 'input[name*="email" i]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
    // No SSN/DOB gate — safe to submit arbitrary name/email for noise mode
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
    // No SSN/DOB gate — safe to submit arbitrary name/email for noise mode
    acceptsBogus: true,
  },

  {
    name: 'SocialCatfish',
    method: 'direct-form',
    optOutUrl: 'https://socialcatfish.com/opt-out/',
    formFields: { 'input[name*="name" i]': N, 'input[name*="email" i]': E },
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

  {
    name: 'ClustrMaps',
    method: 'direct-form',
    optOutUrl: 'https://clustrmaps.com/bl/opt-out',
    formFields: { 'input[name*="name" i]': N, 'input[name*="email" i]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  {
    name: 'PrivateRecords',
    method: 'direct-form',
    optOutUrl: 'https://www.privaterecords.net/api/helper/optOutLight/search',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  // ═══ Priority 1 — Major upstream aggregators ══════════════════════════════
  // These feed many smaller sites — highest leverage opt-outs

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
    name: 'ZoomInfo',
    method: 'direct-form',
    optOutUrl: 'https://www.zoominfo.com/update-my-info',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
  },

  {
    name: 'Clearbit',
    method: 'direct-form',
    optOutUrl: 'https://clearbit.com/privacy/opt-out',
    formFields: { 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
  },

  // ═══ Additional people-search / data broker sites ════════════════════════

  {
    name: 'PeekYou',
    method: 'direct-form',
    optOutUrl: 'https://www.peekyou.com/about/contact/optout/',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E, 'input[name*="city" i]': C, 'input[name*="state" i]': ST },
    submitSelector: 'button[type="submit"],input[type="submit"]',
    captchaLikely: false,
    priority: 1,
  },

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
  },

  {
    name: 'Spokeo (email)',
    method: 'email',
    emailTo: 'privacy@spokeo.com',
    priority: 2,
  },

  {
    name: 'Epsilon',
    method: 'direct-form',
    optOutUrl: 'https://www.epsilon.com/privacy/data-subject-rights-request',
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
    name: 'Equifax (marketing)',
    method: 'direct-form',
    optOutUrl: 'https://www.equifax.com/privacy/opt-out/',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[type="email"]': E, 'input[name*="zip" i]': Z },
    submitSelector: 'button[type="submit"],input[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  {
    name: 'Experian (marketing)',
    method: 'direct-form',
    optOutUrl: 'https://www.experian.com/privacy/opting_out.html',
    formFields: { 'input[name*="first" i]': F, 'input[name*="last" i]': L, 'input[name*="addr" i]': C, 'input[name*="zip" i]': Z },
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

  // ═══ Email-based opt-outs ═════════════════════════════════════════════════

  {
    name: 'Pipl',
    method: 'email',
    emailTo: 'privacy@pipl.com',
    priority: 2,
  },

  // ═══ Manual-only (requires human interaction) ═════════════════════════════

  {
    name: 'Google — Results About You',
    method: 'manual',
    optOutUrl: 'https://myaccount.google.com/data-and-privacy',
    notes: 'Use "Results about you" to flag address/phone in search results.',
    priority: 1,
  },

  {
    name: 'Google — Outdated Content',
    method: 'manual',
    optOutUrl: 'https://search.google.com/search-console/remove-outdated-content',
    notes: 'Submit if any cached pages show your personal info.',
    priority: 3,
  },

];
