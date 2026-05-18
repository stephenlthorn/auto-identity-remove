/**
 * lib/platform.js
 *
 * Platform detection scaffolding for later work packages (cross-platform
 * notifications, browser-open, etc.). Nothing imports this yet.
 */

/**
 * Map a Node `process.platform` string to a friendly platform name.
 * @param {string} [platform=process.platform] - e.g. 'darwin', 'win32', 'linux'
 * @returns {'macos'|'linux'|'windows'}
 */
function getPlatform(platform = process.platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

module.exports = { getPlatform };
