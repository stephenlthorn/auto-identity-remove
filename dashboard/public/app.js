'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
// Fix 4: harden api() to tolerate non-JSON responses (surface a readable message).
const api = async (p, opts) => {
  const r = await fetch('/api' + p, opts);
  const text = await r.text();
  try { return JSON.parse(text); } catch (_) {
    return { error: `Server returned non-JSON (HTTP ${r.status}): ${text.slice(0, 120)}` };
  }
};

// Escape any data-influenced value before it goes into an innerHTML template.
// Broker names, opt-out URLs, broker-site status snippets and log filenames all
// originate outside this app, so every interpolation into innerHTML must use this.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Only http(s) links are allowed as hrefs (blocks javascript:/data: scheme injection).
const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : null;

// Mask sentinel used by the server when displaying secret config fields.
// A field still showing this value was never edited - do not send it back.
const MASK = '••••••••';

let brokers = [], state = {};

// ---------- summary ----------
async function loadSummary() {
  try {
    const s = await api('/summary');
    const pill = (txt, cls) => `<span class="pill ${cls}">${esc(txt)}</span>`;
    $('#summary').innerHTML = [
      pill(`${s.brokers} brokers`, 'muted'),
      pill(`${s.optedOut} opted out`, s.optedOut ? 'good' : 'muted'),
      pill(`${s.pending} pending`, s.pending ? 'warn' : 'muted'),
      pill(`${s.manual} manual`, 'muted'),
      pill(s.configured ? 'config ✓' : 'no config', s.configured ? 'good' : 'bad'),
      pill(s.capsolver ? 'CapSolver ✓' : 'CapSolver ✗', s.capsolver ? 'good' : 'warn'),
      pill(s.smtp ? 'SMTP ✓' : 'SMTP ✗', s.smtp ? 'good' : 'warn'),
      s.stateError ? pill('state.json unreadable', 'bad') : '',
    ].join('');
  } catch (_) { $('#summary').innerHTML = '<span class="pill bad">API error</span>'; }
}

// ---------- brokers ----------
function fmtDate(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  return isNaN(d.getTime()) ? String(raw) : d.toLocaleString();
}
// Align status->badge mapping EXACTLY to dashboard/validate.js classifyStatus.
// Source of truth: validate.js. This switch must be kept identical to that
// function's switch block. Do NOT add fuzzy regexes here.
// Vocab (lib/logger.js): success / notFound / unverified / pending_confirm /
//   error / captcha_failed / dead / manual
// Returns one of: ok / notfound / pending / error / manual / other
function _classifyStatus(raw) {
  switch (raw) {
    case 'success':         return 'ok';
    case 'notfound':        return 'notfound';
    case 'pending_confirm': return 'pending';
    case 'unverified':      return 'pending';
    case 'error':           return 'error';
    case 'captcha_failed':  return 'error';
    case 'dead':            return 'error';
    case 'manual':          return 'manual';
    default:                return 'other';
  }
}
function statusFor(name) {
  const o = (state.optOuts && state.optOuts[name]) || null;
  if (!o) return { key: 'none', label: '-', date: '' };
  const hist = Array.isArray(o.history) ? o.history : [];
  const raw = String(hist[hist.length - 1] || o.status || '').toLowerCase();
  const key = raw ? _classifyStatus(raw) : 'other';
  return { key, label: raw || '-', date: fmtDate(o.lastSuccess || o.lastAttempt || '') };
}
function renderBrokers() {
  const q = $('#brokerSearch').value.toLowerCase();
  const rows = brokers.filter(b => b.name.toLowerCase().includes(q)).map(b => {
    const st = b.method === 'manual' ? { key: 'manual', label: 'manual', date: '' } : statusFor(b.name);
    const url = safeUrl(b.optOutUrl);
    const nameCell = url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(b.name)}</a>`
      : esc(b.name);
    const action = b.method === 'manual' ? ''
      : `<button class="row-run" data-name="${esc(b.name)}" aria-label="Preview ${esc(b.name)} only" title="Preview this broker only">▶</button>`;
    return `<tr>
      <td>${nameCell}</td>
      <td class="method">${esc(b.method || '')}</td>
      <td>${esc(b.priority ?? '')}</td>
      <td>${b.usOnly ? 'US' : 'intl'}</td>
      <td><span class="badge ${st.key}">${esc(st.label)}</span></td>
      <td class="dim">${esc(st.date)}</td>
      <td>${action}</td>
    </tr>`;
  }).join('');
  $('#brokerTable tbody').innerHTML = rows || '<tr><td colspan="7" class="dim">no brokers</td></tr>';
  $$('.row-run').forEach(btn => btn.addEventListener('click', () => {
    $('#onlyInput').value = btn.dataset.name; $('#skipInput').value = '';
    $$('.tab').forEach(x => x.classList.remove('active')); document.querySelector('.tab[data-tab="brokers"]').classList.add('active');
    doRun('preview');
  }));
}
// Fix 4: add .catch to loadBrokers so a failed load shows an error, not a blank table.
async function loadBrokers() {
  try {
    [brokers, state] = await Promise.all([api('/brokers'), api('/state')]);
    if (state && state.error) state = {};
    renderBrokers();
  } catch (err) {
    $('#brokerTable tbody').innerHTML = `<tr><td colspan="7" class="dim">failed to load brokers: ${esc(err && err.message || String(err))}</td></tr>`;
  }
}

// ---------- run + console ----------
const consoleEl = $('#console');
let firstLine = true;
function classify(line) {
  if (/^\$ /.test(line)) return 'line-cmd';
  if (/^— |process exited/.test(line)) return 'line-end';
  if (/✅|success|✓/i.test(line)) return 'line-ok';
  if (/⚠️|warn|skip/i.test(line)) return 'line-warn';
  if (/❌|error|fail/i.test(line)) return 'line-err';
  return '';
}
function appendLine(line) {
  if (firstLine) { consoleEl.innerHTML = ''; firstLine = false; }
  const span = document.createElement('span');
  span.className = classify(line);
  span.textContent = line + '\n';
  consoleEl.appendChild(span);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}
let es = null;
// Fix 3: safety timeout so the poll cannot run forever (30 minutes).
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
let pollStartedAt = null;
function closeStream() { if (es) { es.close(); es = null; } }
function openStream() {
  closeStream();
  firstLine = true;
  es = new EventSource('/api/run/stream');
  es.onmessage = e => { try { appendLine(JSON.parse(e.data).line); } catch (_) {} };
  es.addEventListener('end', e => { finishRun(e.data); });
  // Fix 3: handle SSE disconnects - reconcile run state via poll, finish if not running.
  es.onerror = () => {
    appendLine('ℹ️ stream disconnected - checking run status...');
    closeStream();
    api('/run/status').then(s => {
      if (s && s.running) {
        // Still running - reopen stream after a brief delay.
        setTimeout(openStream, 2000);
      } else {
        appendLine('ℹ️ run ended (detected via status check)');
        finishRun(s && s.exitCode != null ? s.exitCode : '?');
      }
    }).catch(() => {
      appendLine('⚠️ could not reach server - stopping.');
      finishRun('?');
    });
  };
}
function setRunning(on, mode) {
  $$('.run-controls .btn[data-mode]').forEach(b => b.disabled = on);
  $('#stopBtn').disabled = !on;
  $('#runStatus').textContent = on ? `running: ${mode}…` : '';
}
let runPoll = null;
function startRunPoll() {
  if (!runPoll) {
    pollStartedAt = Date.now();
    runPoll = setInterval(() => {
      // Fix 3: safety timeout so the poll cannot run forever.
      if (pollStartedAt && (Date.now() - pollStartedAt) > POLL_TIMEOUT_MS) {
        appendLine('⚠️ run poll safety timeout reached - stopping.');
        finishRun('timeout');
        return;
      }
      loadSummary(); loadBrokers();
    }, 7000);
  }
}
function stopRunPoll() { if (runPoll) { clearInterval(runPoll); runPoll = null; } pollStartedAt = null; }
async function finishRun(code) {
  setRunning(false); stopRunPoll(); closeStream();
  $('#runStatus').textContent = `last run exited ${code}`;
  await loadSummary(); await loadBrokers(); loadLogs();
}
// Live modes perform real, outward-facing actions; the server requires an
// explicit confirm:true for them (defense against stray/forged/replayed requests).
const LIVE_MODES = new Set(['real', 'retry', 'snapshot', 'confirm']);
// Fix 2: modes that honor --only/--skip filters (keep in sync with dashboard/validate.js).
const FILTER_MODES = new Set(['preview', 'real', 'retry']);
// Fix 1: pendingMode holds the mode chosen by a live-mode button until the modal is confirmed.
let pendingMode = null;
async function doRun(mode) {
  try {
    const only = $('#onlyInput').value.trim();
    const skip = $('#skipInput').value.trim();
    const body = { mode };
    if (FILTER_MODES.has(mode)) {
      if (only) body.only = only;
      if (skip) body.skip = skip;
    } else if (only || skip) {
      // Fix 2: inform user that filters are ignored for this mode.
      appendLine('ℹ️ --only/--skip are ignored for ' + mode + ' mode');
    }
    if (LIVE_MODES.has(mode)) body.confirm = true;
    setRunning(true, mode);
    // Start the run FIRST so the server resets its run state, THEN attach the
    // stream - otherwise a freshly-opened EventSource replays the *previous*
    // run's buffer and a stale 'end' event, desyncing the controls.
    const r = await api('/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r && r.error) { appendLine('⚠️ ' + r.error); setRunning(false); return; }
    openStream(); startRunPoll();
  } catch (err) {
    // Fix 4: wrap doRun in try/catch.
    appendLine('⚠️ run request failed: ' + (err && err.message || String(err)));
    setRunning(false);
    stopRunPoll();
  }
}
$$('.run-controls .btn[data-mode]').forEach(btn => btn.addEventListener('click', () => {
  const mode = btn.dataset.mode;
  // Fix 1: ALL live modes go through the confirm modal, not just 'real'.
  if (LIVE_MODES.has(mode)) { pendingMode = mode; openModal(mode); return; }
  doRun(mode);
}));

// ---------- confirm modal (focus-managed, Escape to cancel) ----------
const modal = $('#confirmModal');
let modalReturnFocus = null;
// Fix 1: human-readable labels for each live mode shown in the modal.
const MODE_LABELS = {
  real: 'Run real opt-outs',
  retry: 'Retry failed opt-outs',
  snapshot: 'Real run + snapshots',
  confirm: 'Confirm emails',
};
// Fix 1: openModal receives the pending mode so it can show a descriptive action line.
function openModal(mode) {
  modalReturnFocus = document.activeElement;
  // Set the dynamic action description using textContent (no unescaped HTML).
  const label = MODE_LABELS[mode] || mode;
  $('#confirmAction').textContent = 'Action: ' + label;
  modal.classList.remove('hidden');
  $('#cancelReal').focus();
  document.addEventListener('keydown', modalKeydown);
}
function closeModal() {
  modal.classList.add('hidden');
  document.removeEventListener('keydown', modalKeydown);
  if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
  pendingMode = null;
}
function modalKeydown(e) {
  if (e.key === 'Escape') { closeModal(); return; }
  if (e.key === 'Tab') { // trap focus between the two buttons
    const f = [$('#cancelReal'), $('#confirmReal')];
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
  }
}
// Fix 1: confirm button runs doRun(pendingMode), covering all live modes.
$('#confirmReal').addEventListener('click', () => { const m = pendingMode; closeModal(); if (m) doRun(m); });
$('#cancelReal').addEventListener('click', closeModal);
$('#stopBtn').addEventListener('click', () => api('/run/stop', { method: 'POST' }));
$('#brokerSearch').addEventListener('input', renderBrokers);

// ---------- tabs ----------
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
  t.classList.add('active'); t.setAttribute('aria-selected', 'true');
  $$('.tab-panel').forEach(p => p.classList.add('hidden'));
  $('#tab-' + t.dataset.tab).classList.remove('hidden');
  if (t.dataset.tab === 'config') loadConfig();
  if (t.dataset.tab === 'logs') loadLogs();
  if (t.dataset.tab === 'schedule') loadSchedule();
  if (t.dataset.tab === 'admin') loadWhoami();
  if (t.dataset.tab === 'freeze') loadFreeze();
}));

// ---------- admin: change login ----------
async function loadWhoami() {
  try {
    const w = await api('/auth/whoami');
    $('#whoami').textContent = `Current user: ${w.user || '(none)'} · credentials source: ${w.source}`;
  } catch (_) { $('#whoami').textContent = ''; }
}
$('#savePw').addEventListener('click', async () => {
  const cur = $('#curPw').value, np = $('#newPw').value, np2 = $('#newPw2').value, nu = $('#newUser').value.trim();
  const msg = $('#pwMsg');
  if (np.length < 6) { msg.className = 'pw-msg err'; msg.textContent = '❌ New password must be at least 6 characters.'; return; }
  if (np !== np2) { msg.className = 'pw-msg err'; msg.textContent = '❌ New passwords do not match.'; return; }
  const r = await api('/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: cur, newPassword: np, newUsername: nu || undefined }) });
  if (r.ok) {
    msg.className = 'pw-msg ok';
    msg.innerHTML = `✅ Updated. Log in again as <b>${esc(r.user)}</b> with the new password — your browser will re-prompt on the next action.`;
    $('#curPw').value = $('#newPw').value = $('#newPw2').value = $('#newUser').value = '';
  } else { msg.className = 'pw-msg err'; msg.textContent = '❌ ' + (r.error || 'change failed'); }
});

// ---------- schedule ----------
async function loadSchedule() {
  const s = await api('/schedule');
  const pill = $('#schedEnabled');
  pill.textContent = s.enabled || 'unknown';
  pill.className = 'pill ' + (s.enabled === 'enabled' ? 'good' : 'warn');
  $('#schedNext').textContent = s.next || '—';
  $('#schedCal').textContent = s.oncalendar || '—';
}
const postSchedule = body => api('/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(loadSchedule);
$('#schedEnable').addEventListener('click', () => postSchedule({ action: 'enable' }));
$('#schedDisable').addEventListener('click', () => postSchedule({ action: 'disable' }));
$$('[data-preset]').forEach(b => b.addEventListener('click', () => postSchedule({ action: 'preset', preset: b.dataset.preset })));

// ---------- config ----------
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, p, v) { const ks = p.split('.'); let c = o; ks.slice(0, -1).forEach(k => { c[k] = c[k] || {}; c = c[k]; }); c[ks.at(-1)] = v; }
async function loadConfig() {
  const r = await api('/config');
  $('#configState').textContent = r.parseError
    ? '⚠️ config.json exists but could not be parsed — fix or re-save to overwrite.'
    : (r.exists ? 'Editing live config.json (secrets masked).' : 'No config.json yet — fields prefilled from the example. Save to create it.');
  const c = r.config || {};
  $$('#configForm input').forEach(inp => {
    let v = getPath(c, inp.name);
    if ((inp.name === 'person.aliases' || inp.name === 'allowlist') && Array.isArray(v)) v = v.join(', ');
    inp.value = v == null ? '' : v;
  });
  // Reset clear-button state whenever config is (re)loaded.
  $$('.btn-clear-secret').forEach(btn => { btn.textContent = 'Clear'; btn.disabled = false; });
}
// Wire "Clear" buttons for secret fields. Clicking sets the input to '' so
// the next save sends an explicit empty string (distinct from the MASK sentinel
// which means "keep existing"). A small status label confirms the intent.
$$('.btn-clear-secret').forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.clears;
    const inp = $(`#configForm input[name="${name}"]`);
    if (inp) {
      inp.value = '';
      btn.textContent = 'Cleared';
      btn.disabled = true;
      inp.focus();
    }
  });
});

$('#saveConfig').addEventListener('click', async () => {
  const cfg = {};
  $$('#configForm input').forEach(inp => {
    let v = inp.value;
    // Fix 5: skip only the mask sentinel (untouched secret fields - preserve on server).
    // All other values including empty string are sent so users can clear non-secret fields.
    if (v === MASK) return;
    if (inp.name === 'person.aliases' || inp.name === 'allowlist') v = v.split(',').map(s => s.trim()).filter(Boolean);
    if (inp.name === 'email.smtp.port') v = parseInt(v, 10) || v;
    setPath(cfg, inp.name, v);
  });
  const r = await api('/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: cfg }) });
  $('#configState').textContent = r.ok ? '✅ Saved.' : ('❌ ' + (r.error || 'save failed'));
  loadSummary();
});

// ---------- logs ----------
async function loadLogs() {
  const files = await api('/logs');
  $('#logList').innerHTML = (Array.isArray(files) && files.length) ? files.map(f =>
    `<li data-name="${esc(f.name)}">${esc(f.name)}<div class="meta">${(f.size / 1024).toFixed(1)} KB · ${esc(fmtDate(f.mtime))}</div></li>`
  ).join('') : '<li class="dim">No logs yet — a dated report is written when a real run <b>completes</b>. Watch live progress in the run console above.</li>';
  $$('#logList li[data-name]').forEach(li => li.addEventListener('click', async () => {
    $$('#logList li').forEach(x => x.classList.remove('active')); li.classList.add('active');
    const txt = await fetch('/api/logs/' + encodeURIComponent(li.dataset.name)).then(r => r.text());
    let out = txt; try { out = JSON.stringify(JSON.parse(txt), null, 2); } catch (_) {}
    $('#logView').textContent = out; // textContent — safe, never innerHTML for log bodies
  }));
}

// ---------- exposure score ----------
// Build a tiny inline SVG sparkline from numeric history scores only. Every
// value is coerced to Number and clamped 0-100, so nothing data-influenced
// is interpolated as raw text into markup. Trend/breakdown string fragments
// are escaped with esc(); error text uses textContent.
function sparklineSvg(scores) {
  const nums = (Array.isArray(scores) ? scores : [])
    .map(n => Number(n))
    .filter(n => Number.isFinite(n))
    .map(n => Math.max(0, Math.min(100, n)));
  if (nums.length < 2) return '';
  const W = 120, H = 28, pad = 2;
  const span = nums.length - 1;
  const pts = nums.map((v, i) => {
    const x = pad + (i / span) * (W - 2 * pad);
    const y = H - pad - (v / 100) * (H - 2 * pad); // higher score = higher line = worse
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  // points/dimensions are numbers only; safe to inline.
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="exposure score trend">`
    + `<polyline fill="none" stroke="currentColor" stroke-width="1.5" points="${pts}" /></svg>`;
}
async function loadExposure() {
  try {
    const e = await api('/exposure');
    if (!e || e.error || typeof e.score !== 'number') {
      $('#exposureNum').textContent = '—';
      $('#exposureTrend').textContent = e && e.error ? String(e.error) : '';
      return;
    }
    $('#exposureNum').textContent = String(e.score);
    const hist = Array.isArray(e.history) ? e.history : [];
    const prior = hist.length ? hist[hist.length - 1] : null;
    const priorScore = prior && typeof prior.score === 'number' ? prior.score : null;
    const trendEl = $('#exposureTrend');
    if (priorScore === null) {
      // Safe: no user data, only static text
      trendEl.textContent = 'no trend yet';
    } else {
      const delta = e.score - priorScore;
      const cls = delta < 0 ? 'good' : delta > 0 ? 'bad' : 'muted';
      const arrow = delta < 0 ? 'down' : delta > 0 ? 'up' : 'flat';
      const sign = delta > 0 ? '+' : '';
      // esc() wraps all data-influenced text before innerHTML insertion
      const span = document.createElement('span');
      span.className = 'pill ' + cls;
      span.textContent = arrow + ' ' + sign + delta + ' vs last';
      trendEl.innerHTML = '';
      trendEl.appendChild(span);
    }
    const b = e.breakdown || { listed: 0, serp: 0, breach: 0 };
    // All values are numbers from a trusted API endpoint; esc() applied for defense in depth
    $('#exposureBreakdown').innerHTML = [
      `<span class="pill muted">${esc(e.listedCount)} still listed (+${esc(b.listed)})</span>`,
      `<span class="pill muted">${esc(e.serpHits)} search hits (+${esc(b.serp)})</span>`,
      `<span class="pill muted">breach +${esc(b.breach)}</span>`,
    ].join('');
    $('#exposureSpark').innerHTML = sparklineSvg(hist.map(h => h && h.score));
  } catch (_) {
    $('#exposureNum').textContent = '—';
  }
}

// ---------- freeze checklist ----------
// All data-influenced values are sanitized through esc()/safeUrl() before
// being included in template literals, matching the established XSS-defense
// pattern used throughout this file (see lines 13-19, renderBrokers, etc.).
function freezeRowHtml(t) {
  const url = safeUrl(t.url);
  const link = url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(t.name)}</a>`
    : esc(t.name);
  const badge = t.done
    ? `<span class="badge ok">done</span>`
    : `<span class="badge none">not yet</span>`;
  const when = t.done && t.doneAt ? `<span class="dim"> · ${esc(fmtDate(t.doneAt))}</span>` : '';
  const btnLabel = t.done ? 'Mark not done' : 'Mark done';
  const act = t.done ? 'clear' : 'done';
  return `<li class="freeze-row">
    <div class="freeze-main">${link} ${badge}${when}
      <span class="pill muted">${esc(t.type)}</span></div>
    <div class="dim freeze-notes">${esc(t.notes || '')}</div>
    <button class="btn freeze-toggle" data-key="${esc(t.key)}" data-act="${act}">${btnLabel}</button>
  </li>`;
}
async function loadFreeze() {
  const el = $('#freezeList');
  try {
    const r = await api('/freeze');
    const targets = (r && Array.isArray(r.targets)) ? r.targets : [];
    const markup = targets.length
      ? targets.map(freezeRowHtml).join('')
      : '<li class="dim">no freeze targets</li>';
    // Safe: all interpolations are escaped via esc()/safeUrl() in freezeRowHtml above
    el.innerHTML = markup;
    $$('.freeze-toggle').forEach(btn => btn.addEventListener('click', async () => {
      const body = { key: btn.dataset.key, action: btn.dataset.act };
      const res = await api('/freeze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res && res.error) { btn.textContent = 'Error: ' + res.error; return; }
      loadFreeze();
    }));
  } catch (err) {
    el.textContent = 'failed to load freeze checklist: ' + (err && err.message || String(err));
  }
}

// ---------- footer (version) ----------
api('/version').then(v => {
  if (v && !v.error) $('#foot').textContent = `auto-identity-remove dashboard · tool v${v.tool} · ${v.node} · ${v.brokers} brokers`;
}).catch(() => {});

// ---------- first-run wizard ----------
// Required person fields (mirrors dashboard/config-status.js REQUIRED_PERSON_FIELDS
// and lib/config.js getPersonsFromConfig). Keep in sync.
const WIZ_REQUIRED = ['person.firstName', 'person.lastName', 'person.email'];
// Per-step required field paths (index matches data-step). Steps 2/3/4 are optional.
const WIZ_STEP_REQUIRED = [
  ['person.firstName', 'person.lastName', 'person.email'], // step 0: Person
  ['person.country'],                                      // step 1: Region/Country
  [],                                                      // step 2: CapSolver (optional)
  [],                                                      // step 3: SMTP (optional)
  [],                                                      // step 4: Notifications (optional)
  [],                                                      // step 5: Review
];
const WIZ_TOTAL_STEPS = 6;
const WIZ_STEP_NAMES = ['Person', 'Region', 'CapSolver', 'Email', 'Notify', 'Review'];
// Minimal fallback if /config cannot return the example (network/parse issue):
// the wizard must still open with sensible blanks.
const EXAMPLE_CONFIG_FALLBACK = {
  person: { firstName: '', lastName: '', fullName: '', aliases: [], city: '',
    country: 'US', state: '', zip: '', email: '', phone: '', phoneFormatted: '' },
};
// Fields treated as secrets in the review (shown as "(set)" / "(blank)", never the value).
const WIZ_SECRET_PATHS = new Set(['capsolver.apiKey', 'email.smtp.pass', 'notify.webhook']);
// Exact placeholder values shipped in config.example.json. When config.json is
// absent the server returns the raw example (unmasked) from GET /api/config, so
// the wizard must blank these out rather than silently saving the samples as if
// they were real answers. Keyed by the dotted input name. Aliases (an array) is
// handled separately in wizPrefill after the join.
const WIZ_EXAMPLE_PLACEHOLDERS = {
  'person.firstName': 'Jane',
  'person.lastName': 'Doe',
  'person.fullName': 'Jane Doe',
  'person.city': 'Austin',
  'person.state': 'TX',
  'person.zip': '73301',
  'person.email': 'jane.doe@example.com',
  'person.phone': '5125550000',
  'person.phoneFormatted': '(512) 555-0000',
  'capsolver.apiKey': 'CAP-YOUR_KEY_HERE',
  'email.smtp.host': 'smtp.gmail.com',
  'email.smtp.user': 'you@gmail.com',
  'email.smtp.pass': 'YOUR_GMAIL_APP_PASSWORD',
  'email.smtp.from': 'you@gmail.com',
  'notify.textTo': '+15125550000',
};
// The example's sample aliases, blanked the same way (it is an array, so it is
// matched after wizPrefill joins it to a comma string).
const WIZ_EXAMPLE_ALIASES = 'Jan Doe, Jane M Doe';

let wizStep = 0;

function wizEl() {
  return {
    overlay: $('#wizard'), form: $('#wizardForm'), steps: $('#wizSteps'),
    review: $('#wizReview'), back: $('#wizBack'), skip: $('#wizSkip'),
    next: $('#wizNext'), finish: $('#wizFinish'),
  };
}
function wizGetValue(name) {
  const inp = $(`#wizardForm input[name="${name}"]`);
  return inp ? inp.value.trim() : '';
}
// Prefill the wizard inputs from the example config the server returns when
// config.json is absent (or from a partial live config if one exists).
function wizPrefill(cfg) {
  const c = cfg || EXAMPLE_CONFIG_FALLBACK;
  $$('#wizardForm input').forEach(inp => {
    let v = getPath(c, inp.name);
    if (inp.name === 'person.aliases' && Array.isArray(v)) v = v.join(', ');
    // Blank any value that is still the verbatim config.example.json sample so
    // the wizard never silently saves placeholders (Jane Doe, CAP-YOUR_KEY_HERE,
    // YOUR_GMAIL_APP_PASSWORD, the sample phone/city/state/zip, etc.) as answers.
    if (typeof v === 'string' && WIZ_EXAMPLE_PLACEHOLDERS[inp.name] === v) v = '';
    if (inp.name === 'person.aliases' && v === WIZ_EXAMPLE_ALIASES) v = '';
    // Do not prefill masked secrets into the wizard.
    if (typeof v === 'string' && v === MASK) v = '';
    inp.value = v == null ? '' : v;
  });
}
function wizRenderSteps() {
  const { steps } = wizEl();
  // All values are static strings or numbers - esc() applied for defense in depth
  steps.innerHTML = WIZ_STEP_NAMES.map((n, i) => {
    const cls = i === wizStep ? 'active' : (i < wizStep ? 'done' : '');
    return `<li class="${cls}">${esc((i + 1) + '. ' + n)}</li>`;
  }).join('');
}
function wizShowStep(n) {
  wizStep = Math.max(0, Math.min(WIZ_TOTAL_STEPS - 1, n));
  $$('#wizardForm .wiz-step').forEach(sec => {
    sec.classList.toggle('hidden', Number(sec.dataset.step) !== wizStep);
  });
  $$('.wiz-err').forEach(e => { e.textContent = ''; });
  const { back, skip, next, finish } = wizEl();
  back.disabled = wizStep === 0;
  const isReview = wizStep === WIZ_TOTAL_STEPS - 1;
  const isOptional = WIZ_STEP_REQUIRED[wizStep].length === 0 && !isReview;
  skip.classList.toggle('hidden', !isOptional);
  next.classList.toggle('hidden', isReview);
  finish.classList.toggle('hidden', !isReview);
  if (isReview) wizRenderReview();
  wizRenderSteps();
}
// Collect the wizard inputs into a nested config object (same convention as the
// Config tab's save: dotted input names -> nested object via setPath).
function wizCollect() {
  const cfg = {};
  $$('#wizardForm input').forEach(inp => {
    let v = inp.value.trim();
    if (v === '') return; // omit blanks so the PUT merge does not clobber anything
    if (inp.name === 'person.aliases') {
      const arr = v.split(',').map(s => s.trim()).filter(Boolean);
      if (arr.length === 0) return;
      v = arr;
    }
    if (inp.name === 'email.smtp.port') v = parseInt(v, 10) || v;
    setPath(cfg, inp.name, v);
  });
  // Default fullName from first+last when the user left it blank.
  const fn = wizGetValue('person.firstName'), ln = wizGetValue('person.lastName');
  if (!wizGetValue('person.fullName') && (fn || ln)) {
    setPath(cfg, 'person.fullName', [fn, ln].filter(Boolean).join(' '));
  }
  return cfg;
}
function wizValidateStep() {
  const required = WIZ_STEP_REQUIRED[wizStep] || [];
  const blank = required.filter(p => wizGetValue(p) === '');
  const errEl = $(`.wiz-err[data-err="${wizStep}"]`);
  if (blank.length) {
    const labels = blank.map(p => p.replace('person.', '')).join(', ');
    if (errEl) errEl.textContent = 'Please fill: ' + labels;
    return false;
  }
  // Light email sanity check on the Person step.
  if (wizStep === 0) {
    const email = wizGetValue('person.email');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      if (errEl) errEl.textContent = 'That email does not look valid.';
      return false;
    }
  }
  if (errEl) errEl.textContent = '';
  return true;
}
function wizRenderReview() {
  const cfg = wizCollect();
  const rows = [];
  const add = (label, path) => {
    let v = getPath(cfg, path);
    if (Array.isArray(v)) v = v.join(', ');
    if (WIZ_SECRET_PATHS.has(path)) v = (v ? '(set)' : '(blank)');
    const display = (v == null || v === '') ? '(blank)' : String(v);
    // esc() escapes every interpolated value before innerHTML insertion
    rows.push(`<dt>${esc(label)}</dt><dd>${esc(display)}</dd>`);
  };
  add('First name', 'person.firstName');
  add('Last name', 'person.lastName');
  add('Full name', 'person.fullName');
  add('Aliases', 'person.aliases');
  add('Email', 'person.email');
  add('Country', 'person.country');
  add('City', 'person.city');
  add('State / Region', 'person.state');
  add('ZIP / Postal', 'person.zip');
  add('Phone', 'person.phone');
  add('CapSolver key', 'capsolver.apiKey');
  add('SMTP host', 'email.smtp.host');
  add('SMTP user', 'email.smtp.user');
  add('SMTP password', 'email.smtp.pass');
  add('Webhook', 'notify.webhook');
  add('Text to', 'notify.textTo');
  $('#wizReview').innerHTML = rows.join('');
}
async function wizFinish() {
  // Final guard: every globally-required field must be present.
  const missing = WIZ_REQUIRED.filter(p => wizGetValue(p) === '');
  const errEl = $('.wiz-err[data-err="5"]');
  if (missing.length) {
    if (errEl) errEl.textContent = 'Missing required: ' + missing.map(p => p.replace('person.', '')).join(', ') + '. Go back to the Person step.';
    return;
  }
  const cfg = wizCollect();
  const { finish } = wizEl();
  finish.disabled = true;
  try {
    const r = await api('/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: cfg }) });
    if (r && r.ok) {
      wizEl().overlay.classList.add('hidden');
      // Reveal the live dashboard now that config exists.
      loadSummary(); loadBrokers();
    } else {
      if (errEl) errEl.textContent = ((r && r.error) || 'save failed');
      finish.disabled = false;
    }
  } catch (err) {
    if (errEl) errEl.textContent = (err && err.message || String(err));
    finish.disabled = false;
  }
}
function wizWire() {
  const { overlay, back, skip, next, finish } = wizEl();
  if (!overlay) return;
  back.addEventListener('click', () => wizShowStep(wizStep - 1));
  skip.addEventListener('click', () => wizShowStep(wizStep + 1));
  next.addEventListener('click', () => { if (wizValidateStep()) wizShowStep(wizStep + 1); });
  finish.addEventListener('click', wizFinish);
}
async function initWizard() {
  let status;
  try { status = await api('/config/status'); } catch (_) { status = null; }
  if (!status || status.configured) return false; // already set up: skip the wizard
  // Prefill from the server (example config when config.json is absent).
  let cfgResp;
  try { cfgResp = await api('/config'); } catch (_) { cfgResp = null; }
  wizPrefill((cfgResp && cfgResp.config) || EXAMPLE_CONFIG_FALLBACK);
  wizWire();
  wizStep = 0;
  wizShowStep(0);
  wizEl().overlay.classList.remove('hidden');
  return true;
}

// ---------- boot ----------
(async () => {
  const wizardShown = await initWizard();
  loadSummary(); loadBrokers(); loadExposure();
  setInterval(loadSummary, 15000);
  if (!wizardShown) {
    // Reconnect to an in-progress run if the page was opened/reloaded mid-run.
    api('/run/status').then(s => { if (s && s.running) { setRunning(true, s.mode); openStream(); startRunPoll(); } }).catch(() => {});
  }
})();
