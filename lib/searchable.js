/**
 * lib/searchable.js
 *
 * Whether a broker can be searched for a listing: it has a search page and a
 * pattern that recognises a listing link on it. The broker's `method` does not
 * matter. A people-search site can keep `direct-form` as its opt-out method and
 * still have a search step, and verify and scan use that step the same way as for
 * a `search-form` broker.
 */

'use strict';

function canSearch(broker) {
  return Boolean(broker && broker.searchUrl && broker.listingPattern);
}

module.exports = { canSearch };
