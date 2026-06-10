'use strict';
/*
 * lib/dashboard-creds.js - generate ephemeral credentials for the local
 * dashboard so `aidr dashboard` never starts unauthenticated.
 *
 * The password is a URL-safe base64url string derived from 18 random bytes
 * (24 chars), safe to drop into an HTTP Basic credential and a localhost URL.
 */

const crypto = require('crypto');

function generateDashboardCreds() {
  const pass = crypto.randomBytes(18).toString('base64url');
  return { user: 'admin', pass };
}

module.exports = { generateDashboardCreds };
