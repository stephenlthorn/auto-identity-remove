'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const api = (p, opts) => fetch('/api' + p, opts).then(r => r.json());

// Escape any data-influenced value before it goes into an innerHTML template.
// Broker names, opt-out URLs, broker-site status snippets and log filenames all
// originate outside this app, so every interpolation into innerHTML must use this.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Only http(s) links are allowed as hrefs (blocks javascript:/data: scheme injection).
const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : null;

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
function statusFor(name) {
  const o = (state.optOuts && state.optOuts[name]) || null;
  if (!o) return { key: 'none', label: '—', date: '' };
  const hist = Array.isArray(o.history) ? o.history : [];
  const raw = String(hist[hist.length - 1] || o.status || '').toLowerCase();
  let key = 'none';
  if (/success|removed|confirmed|opted/.test(raw)) key = 'ok';
  else if (/pending|await|sent|unverified/.test(raw)) key = 'pending';
  else if (/error|fail|dead/.test(raw)) key = 'err';
  else if (/notfound|not_found|not listed/.test(raw)) key = 'notlisted';
  return { key, label: raw || '—', date: fmtDate(o.lastSuccess || o.lastAttempt || '') };
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
async function loadBrokers() {
  [brokers, state] = await Promise.all([api('/brokers'), api('/state')]);
  if (state && state.error) state = {};
  renderBrokers();
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
function closeStream() { if (es) { es.close(); es = null; } }
function openStream() {
  closeStream();
  firstLine = true;
  es = new EventSource('/api/run/stream');
  es.onmessage = e => { try { appendLine(JSON.parse(e.data).line); } catch (_) {} };
  es.addEventListener('end', e => { finishRun(e.data); });
}
function setRunning(on, mode) {
  $$('.run-controls .btn[data-mode]').forEach(b => b.disabled = on);
  $('#stopBtn').disabled = !on;
  $('#runStatus').textContent = on ? `running: ${mode}…` : '';
}
let runPoll = null;
function startRunPoll() { if (!runPoll) runPoll = setInterval(() => { loadSummary(); loadBrokers(); }, 7000); }
function stopRunPoll() { if (runPoll) { clearInterval(runPoll); runPoll = null; } }
async function finishRun(code) {
  setRunning(false); stopRunPoll(); closeStream();
  $('#runStatus').textContent = `last run exited ${code}`;
  await loadSummary(); await loadBrokers(); loadLogs();
}
async function doRun(mode) {
  const body = { mode, only: $('#onlyInput').value.trim() || undefined, skip: $('#skipInput').value.trim() || undefined };
  setRunning(true, mode);
  // Start the run FIRST so the server resets its run state, THEN attach the
  // stream — otherwise a freshly-opened EventSource replays the *previous*
  // run's buffer and a stale 'end' event, desyncing the controls.
  const r = await api('/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r && r.error) { appendLine('⚠️ ' + r.error); setRunning(false); return; }
  openStream(); startRunPoll();
}
$$('.run-controls .btn[data-mode]').forEach(btn => btn.addEventListener('click', () => {
  const mode = btn.dataset.mode;
  if (mode === 'real') { openModal(); return; }
  doRun(mode);
}));

// ---------- confirm modal (focus-managed, Escape to cancel) ----------
const modal = $('#confirmModal');
let modalReturnFocus = null;
function openModal() {
  modalReturnFocus = document.activeElement;
  modal.classList.remove('hidden');
  $('#cancelReal').focus();
  document.addEventListener('keydown', modalKeydown);
}
function closeModal() {
  modal.classList.add('hidden');
  document.removeEventListener('keydown', modalKeydown);
  if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
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
$('#confirmReal').addEventListener('click', () => { closeModal(); doRun('real'); });
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
    if (inp.name === 'person.aliases' && Array.isArray(v)) v = v.join(', ');
    inp.value = v == null ? '' : v;
  });
}
$('#saveConfig').addEventListener('click', async () => {
  const cfg = {};
  $$('#configForm input').forEach(inp => {
    let v = inp.value;
    if (v === '') return;
    if (inp.name === 'person.aliases') v = v.split(',').map(s => s.trim()).filter(Boolean);
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

// ---------- footer (version) ----------
api('/version').then(v => {
  if (v && !v.error) $('#foot').textContent = `auto-identity-remove dashboard · tool v${v.tool} · ${v.node} · ${v.brokers} brokers`;
}).catch(() => {});

// ---------- boot ----------
loadSummary(); loadBrokers();
setInterval(loadSummary, 15000);
// Reconnect to an in-progress run if the page was opened/reloaded mid-run
api('/run/status').then(s => { if (s && s.running) { setRunning(true, s.mode); openStream(); startRunPoll(); } }).catch(() => {});
