#!/usr/bin/env node
/**
 * auto-identity-remove — interactive setup
 *
 * Run once: node setup.js
 *
 * Creates config.json from your answers and walks you through:
 *   • Personal info (name, address, email, phone)
 *   • CapSolver API key (for CAPTCHA-protected sites)
 *   • Accounts for sites that require login (one-time)
 *   • macOS launchd scheduling (1st of every month)
 *   • iMessage notification number
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const readline = require('readline');
const { execSync } = require('child_process');

const isMac = process.platform === 'darwin';

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH  = path.join(__dirname, 'state.json');

// ─── Prompt helper ────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def = '') => new Promise(resolve =>
  rl.question(def ? `${q} [${def}]: ` : `${q}: `, ans => resolve(ans.trim() || def))
);
const askSecret = (q) => new Promise(resolve => {
  process.stdout.write(`${q}: `);
  process.stdin.setRawMode?.(true);
  let val = '';
  process.stdin.resume();
  process.stdin.once('data', d => {
    val = d.toString().trim();
    process.stdout.write('\n');
    process.stdin.setRawMode?.(false);
    resolve(val);
  });
});
const confirm = async (q) => {
  const ans = (await ask(`${q} (y/n)`, 'y')).toLowerCase();
  return ans === 'y' || ans === 'yes';
};

// ─── Main setup ───────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔒 auto-identity-remove — Setup\n');
  console.log('This will create config.json with your personal info (gitignored).');
  console.log('Run this once. Re-run anytime to update.\n');

  // Load existing config if present
  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    console.log('ℹ  Existing config.json found — press Enter to keep current values.\n');
  }
  const p = existing.person || {};

  // ── Personal info ────────────────────────────────────────────────────────
  console.log('── Personal Info ──────────────────────────────────────────');
  const firstName      = await ask('First name',              p.firstName || '');
  const lastName       = await ask('Last name',               p.lastName  || '');
  const aliasInput     = await ask('Aliases (comma-separated, e.g. "Steve Doe, S Doe")', (p.aliases||[]).join(', '));
  const aliases        = aliasInput ? aliasInput.split(',').map(s => s.trim()).filter(Boolean) : [];
  const city           = await ask('City',                    p.city  || '');
  const state          = await ask('State (2-letter)',        p.state || '');
  const zip            = await ask('ZIP code',                p.zip   || '');
  const email          = await ask('Email address',           p.email || '');
  const phone          = await ask('Phone (digits only, e.g. 5125550000)', p.phone || '');
  const phoneFormatted = phone.length === 10
    ? `(${phone.slice(0,3)}) ${phone.slice(3,6)}-${phone.slice(6)}`
    : phone;

  // ── CapSolver ────────────────────────────────────────────────────────────
  console.log('\n── CAPTCHA Solving ────────────────────────────────────────');
  console.log('Some opt-out forms have CAPTCHAs. CapSolver (capsolver.com)');
  console.log('solves them automatically for ~$0.001 each — pennies per month.');
  console.log('Sign up free at https://capsolver.com and paste your API key below.');
  console.log('Leave blank to skip (those sites go to your manual list instead).\n');
  const capsolverKey = await ask('CapSolver API key', (existing.capsolver||{}).apiKey || '');

  // ── Notification ─────────────────────────────────────────────────────────
  let textTo;
  if (isMac) {
    console.log('\n── iMessage Notification ──────────────────────────────────');
    textTo = await ask('iMessage number to text results to (e.g. +15125550000)', (existing.notify||{}).textTo || '');
  } else {
    console.log('\n── Desktop Notification ─────────────────────────────────');
    textTo = (existing.notify||{}).textTo || '';
    console.log('Desktop notifications will be shown via notify-send.');
  }

  // ── Profile dir ──────────────────────────────────────────────────────────
  const defaultProfileDir = path.join(os.homedir(), '.config', 'auto-identity-remove');
  const profileDir = await ask('Browser profile directory', existing.profileDir || defaultProfileDir);

  // ── Accounts for sites that need login ───────────────────────────────────
  console.log('\n── One-Time Account Setup ─────────────────────────────────');
  console.log('A few high-priority sites require an account to opt out.');
  console.log('Create the accounts now (one-time) and paste credentials here.');
  console.log('They will be stored locally in config.json (gitignored).\n');

  const acctSites = [
    { key: 'spokeo',       url: 'https://www.spokeo.com/signup',       label: 'Spokeo'       },
    { key: 'beenverified', url: 'https://www.beenverified.com/signup', label: 'BeenVerified' },
    { key: 'mylife',       url: 'https://www.mylife.com/signup',       label: 'MyLife'       },
  ];

  const accounts = existing.accounts || {};
  for (const site of acctSites) {
    const hasExisting = accounts[site.key]?.password;
    if (hasExisting) {
      const update = await confirm(`  ${site.label} — account already stored. Update?`);
      if (!update) continue;
    } else {
      const doSetup = await confirm(`  Set up ${site.label} account? (${site.url})`);
      if (!doSetup) {
        accounts[site.key] = { email: email, password: '' };
        continue;
      }
      console.log(`  → Opening ${site.url} in your browser…`);
      try { execSync(`${isMac ? 'open' : 'xdg-open'} "${site.url}"`); } catch(_) {}
      console.log('  Create the account, then come back here.\n');
      await ask('  Press Enter when done');
    }
    const acctEmail = await ask(`  ${site.label} login email`, email);
    const acctPass  = await ask(`  ${site.label} password`);
    accounts[site.key] = { email: acctEmail, password: acctPass };
    console.log(`  ✓ ${site.label} credentials saved.\n`);
  }

  // ── Build config ─────────────────────────────────────────────────────────
  const config = {
    person: {
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      aliases,
      city,
      state,
      zip,
      email,
      phone,
      phoneFormatted,
    },
    capsolver: { apiKey: capsolverKey || 'CAP-YOUR_KEY_HERE' },
    accounts,
    notify: { textTo },
    profileDir,
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log('\n✅ config.json saved.\n');

  // Initialize state.json if not present
  if (!fs.existsSync(STATE_PATH)) {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ optOuts: {}, createdAt: new Date().toISOString() }, null, 2));
    console.log('✅ state.json initialized (tracks opt-out history).\n');
  }

  // ── Scheduling ───────────────────────────────────────────────────────────
  console.log('── Monthly Schedule ────────────────────────────────────────');
  const doSchedule = await confirm('Schedule to run automatically on the 1st of every month at 9am?');
  if (doSchedule) {
    const scriptPath = path.join(__dirname, 'run.sh');
    const logDir = path.join(__dirname, 'logs');
    fs.mkdirSync(logDir, { recursive: true });

    if (isMac) {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.auto-identity-remove.plist');
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.auto-identity-remove</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${scriptPath}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Day</key><integer>1</integer>
        <key>Hour</key><integer>9</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${logDir}/launchd.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/launchd.error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PLAYWRIGHT_BROWSERS_PATH</key>
        <string>${process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>`;

    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null; launchctl load "${plistPath}"`);
      console.log('✅ Scheduled — runs every 1st of the month at 9am.\n');
    } catch(err) {
      console.log(`⚠  launchctl error: ${err.message.slice(0,80)}`);
      console.log(`   Manually load with: launchctl load "${plistPath}"\n`);
    }
  } else {
    const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(systemdDir, { recursive: true });

    const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
      || path.join(os.homedir(), '.cache', 'ms-playwright');

    const serviceFile = path.join(systemdDir, 'auto-identity-remove.service');
    const serviceUnit = `[Unit]
Description=auto-identity-remove monthly data broker opt-out

[Service]
Type=oneshot
ExecStart=/bin/bash ${scriptPath}
Environment=PLAYWRIGHT_BROWSERS_PATH=${browsersPath}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
StandardOutput=append:${logDir}/systemd.log
StandardError=append:${logDir}/systemd.error.log
`;

    const timerFile = path.join(systemdDir, 'auto-identity-remove.timer');
    const timerUnit = `[Unit]
Description=auto-identity-remove monthly timer
Requires=auto-identity-remove.service

[Timer]
OnCalendar=*-*-01 09:00:00
Persistent=true

[Install]
WantedBy=timers.target
`;

    fs.writeFileSync(serviceFile, serviceUnit);
    fs.writeFileSync(timerFile, timerUnit);
    try {
      execSync('systemctl --user daemon-reload 2>/dev/null');
      execSync('systemctl --user stop auto-identity-remove.timer 2>/dev/null; systemctl --user disable auto-identity-remove.timer 2>/dev/null');
      execSync('systemctl --user enable auto-identity-remove.timer');
      execSync('systemctl --user start auto-identity-remove.timer');
      console.log('✅ Scheduled — runs every 1st of the month at 9am.\n');
    } catch(err) {
      console.log(`⚠  systemctl error: ${err.message.slice(0,80)}`);
      console.log(`   Manually enable with:`);
      console.log(`     systemctl --user enable --now auto-identity-remove.timer\n`);
    }
    }
  }

  rl.close();

  console.log('─'.repeat(54));
  console.log('✅ Setup complete!\n');
  console.log('  Run now:      node watcher.js');
  console.log('  Manual run:   ./run.sh');
  console.log('  Check state:  cat state.json\n');
  console.log('Your personal info lives only in config.json (gitignored).');
  console.log('─'.repeat(54) + '\n');
}

main().catch(err => {
  console.error('Setup error:', err.message);
  process.exit(1);
});
