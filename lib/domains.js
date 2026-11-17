'use strict';

/**
 * lib/domains.js
 *
 * One answer to "which company's domain is this host?", shared by the generic
 * runner (explicit-broker identity, row trust), the registry feeds and the DROP
 * coverage rule. It was split in three before (a two-label reducer in
 * lib/serp-scan.js, a better one in generic-runner.js, none in feeds.js), and the
 * naive one turned `ukdata.co.uk` into `co.uk` and a OneTrust rights page into
 * `onetrust.com`, which then "covered" every row on those domains.
 *
 * No public-suffix list is bundled. A suffix is multi-part when it is on the
 * short list below, or when it is a two-letter country code under a generic
 * second-level label (acme.co.kr, acme.com.sg): the list cannot name every
 * registry, and without the second rule two unrelated sites under one country
 * suffix would read as one. Anything else falls back to the last two labels.
 */

// Domains shared by many unrelated organisations: an explicit broker on one of
// them says nothing about a different company's page on the same domain (a
// PureCars opt-out Google Form is not Google's "Results about you"). Only an
// exact host match counts there. A registry broker whose rights page lives on one
// of these is still a registry broker, but its identity is its own website.
const SHARED_PLATFORM_DOMAINS = new Set([
  'google.com', 'microsoft.com', 'live.com', 'ca.gov', 'force.com', 'salesforce.com', 'zendesk.com',
  'onetrust.com', 'trustarc.com', 'osano.com', 'termly.io', 'iubenda.com', 'transcend.io', 'ketch.com',
  'typeform.com', 'jotform.com', 'formstack.com', 'airtable.com', 'notion.site', 'github.io', 'wordpress.com',
  'wixsite.com', 'squarespace.com', 'herokuapp.com', 'azurewebsites.net', 'amazonaws.com', 'cloudfront.net',
]);

const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in', 'com.br', 'com.mx', 'co.za',
]);

function bareHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

// Second-level labels that registries put under a two-letter country code.
const COUNTRY_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

/** True for the last two labels of a host when together they are a suffix, not a company. */
function isMultiPartSuffix(secondLevel, topLevel) {
  if (MULTI_LABEL_SUFFIXES.has(`${secondLevel}.${topLevel}`)) return true;
  return topLevel.length === 2 && /^[a-z]{2}$/.test(topLevel) && COUNTRY_SECOND_LEVEL.has(secondLevel);
}

/** Approximate registrable domain (eTLD+1) without a public-suffix list. */
function registrableDomain(host) {
  const name = bareHost(host);
  // An IP address (v4, or v6 in brackets or with colons) is its own domain: taking
  // its "last two labels" would make 127.0.0.1 and 10.0.0.1 the same site.
  if (/^[\d.]+$/.test(name) || name.includes(':')) return name;
  const labels = name.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const [secondLevel, topLevel] = labels.slice(-2);
  return labels.slice(isMultiPartSuffix(secondLevel, topLevel) ? -3 : -2).join('.');
}

/** True for a name that is only a suffix ("com", "co.uk", "co.kr"): it names no company. */
function isPublicSuffix(name) {
  const text = bareHost(name);
  if (text === '') return false;
  const labels = text.split('.');
  if (labels.length === 1) return true;
  return labels.length === 2 && isMultiPartSuffix(labels[0], labels[1]);
}

/** True when the host's registrable domain is a shared form or hosting platform. */
function isSharedPlatformHost(host) {
  return SHARED_PLATFORM_DOMAINS.has(registrableDomain(host));
}

// A dotted host name made of ordinary labels. Registry cells are third-party text.
const HOST_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function looksLikeHost(host) {
  return HOST_SHAPE.test(bareHost(host));
}

/**
 * True for a registrable domain a registry list may safely hold: a dotted host name
 * that is neither a bare suffix nor a shared form platform. Anything else (a cell
 * reading "constructor", "co.uk", "onetrust.com") names no single company.
 */
function isCoverableDomain(domain) {
  return looksLikeHost(domain) && !isPublicSuffix(domain) && !isSharedPlatformHost(domain);
}

module.exports = {
  SHARED_PLATFORM_DOMAINS,
  MULTI_LABEL_SUFFIXES,
  bareHost,
  registrableDomain,
  isPublicSuffix,
  isSharedPlatformHost,
  looksLikeHost,
  isCoverableDomain,
};
