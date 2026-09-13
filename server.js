require('dotenv').config();
const dns = require('dns');
const express = require('express');
const nodemailer = require('nodemailer');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const { buildSeedState } = require('./seedData');

// Some hosts (Render included) resolve smtp.gmail.com to an IPv6 address
// but don't actually have outbound IPv6 routing to it, so the SMTP
// connection just hangs and times out with ENETUNREACH. Forcing IPv4-first
// resolution avoids that without needing per-connection socket options.
dns.setDefaultResultOrder('ipv4first');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const STATE_FILE = './state.json';
function loadState() { return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {}; }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// A fresh deploy has no state.json — seed it once on boot so the app isn't
// empty on first load. Never overwrites existing state.
if (!fs.existsSync(STATE_FILE)) {
  saveState(buildSeedState());
  console.log('No state.json found — seeded default demo data.');
}

// No real auth in this prototype. Whoever opens the app names themselves on
// first visit (see the identity modal), remembered via a plain cookie — not
// a session, not a login, just "which of these commitments are yours."
function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(header.split(';').map(pair => {
    const i = pair.indexOf('=');
    return i === -1 ? [pair.trim(), ''] : [pair.slice(0, i).trim(), decodeURIComponent(pair.slice(i + 1).trim())];
  }));
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// Prefers Resend's HTTP API (port 443, never blocked) when RESEND_API_KEY is
// set — needed because several PaaS hosts, Render included, silently drop
// outbound raw SMTP connections. Falls back to the SMTP transporter above,
// which is fine for local dev where that restriction doesn't apply.
async function sendEmail({ to, subject, html }) {
  if (process.env.RESEND_API_KEY) {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'Fireflies <onboarding@resend.dev>',
        to,
        subject,
        html,
      }),
    });
    if (!resp.ok) throw new Error(`Resend API error ${resp.status}: ${await resp.text()}`);
    return;
  }
  await transporter.sendMail({ from: '"Fireflies" <bot@fireflies-prototype.test>', to, subject, html });
}

const BASE_URL = process.env.BASE_URL;

// The one address real email delivery works for in this prototype (see
// sendEmail's Resend sandbox comment above). Anyone else gets the simulated
// inbox at GET /inbox instead of a real send attempt.
const DEMO_RECIPIENT = 'mukundkorapati@gmail.com';

// A commitment record has a `status` field; a token record does not.
// Both live in the same flat state file, keyed by their own id/token.
function listCommitments(state) {
  return Object.entries(state)
    .filter(([, v]) => v && typeof v === 'object' && v.status)
    .map(([id, v]) => ({ id, ...v }));
}

function openCommitmentsFor(state, ownerEmail) {
  return listCommitments(state).filter(c => c.ownerEmail === ownerEmail && c.status === 'open');
}

// Rebuilds { commitment, doneLink, notDoingLink } for each open commitment
// tagged to ownerEmail, using whatever unused tokens already exist for it
// (created by /trigger). Used by the simulated inbox — it needs the same
// links a real digest email would have carried, without re-sending anything.
function buildDigestPreview(state, ownerEmail) {
  const open = openCommitmentsFor(state, ownerEmail);
  return open.map(c => {
    const entries = Object.entries(state);
    const doneEntry = entries.find(([, v]) => v.commitment_id === c.id && v.action === 'done' && !v.used);
    const notDoingEntry = entries.find(([, v]) => v.commitment_id === c.id && v.action === 'not_doing' && !v.used);
    return {
      commitment: c,
      doneLink: doneEntry ? `/confirm?token=${doneEntry[0]}` : null,
      notDoingLink: notDoingEntry ? `/confirm?token=${notDoingEntry[0]}` : null,
    };
  });
}

function pushHistory(commitment, status, extra = {}) {
  if (!Array.isArray(commitment.history)) commitment.history = [];
  commitment.history.push({ status, at: Date.now(), ...extra });
}

// Standalone Fireflies-styled page for email-landing routes (/confirm) —
// no sidebar/topbar, just a centered branded card, since the visitor isn't
// "in the app" yet, they clicked an email link.
function renderStandalone(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Fireflies</title>
<style>${FIREFLIES_CSS}</style>
</head>
<body>
  <div class="standalone-wrap">
    <div class="standalone-brand"><span class="avatar">F</span> Fireflies</div>
    <div class="card standalone-card">${bodyHtml}</div>
  </div>
</body>
</html>`;
}

// A simulated email client for any recipient other than DEMO_RECIPIENT (see
// /trigger) — same confirm links a real digest would have carried, just
// read here instead of in an actual inbox, so the resolve flow is testable
// by anyone regardless of the sandbox sender's recipient restriction.
function renderInboxPage(ownerEmail, items, view) {
  const count = items.length;
  const messageRows = items.map(({ commitment, doneLink, notDoingLink }) => `
    <div class="inbox-commitment-row">
      <div>
        <div class="inbox-commitment-text">${esc(commitment.text)}</div>
        <div class="muted small">${esc(commitment.meeting)}</div>
      </div>
      <div class="inbox-commitment-actions">
        ${doneLink ? `<a class="btn btn-primary" href="${doneLink}">Done</a>` : ''}
        ${notDoingLink ? `<a class="btn" href="${notDoingLink}">Not doing</a>` : ''}
      </div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Inbox (demo) — Fireflies</title>
<style>${FIREFLIES_CSS}</style>
</head>
<body>
  <div class="standalone-wrap">
    <div class="standalone-brand"><span class="avatar">✉️</span> Simulated inbox</div>
    <div class="card" style="width:100%; max-width:540px; padding:0; overflow:hidden;">
      <div style="padding:14px 20px; border-bottom:1px solid var(--border); background:var(--page-bg);">
        <div class="muted small">
          Real delivery only works for the demo account in this prototype —
          here's what would have landed in <strong>${esc(ownerEmail)}</strong>'s inbox.
        </div>
      </div>
      <div id="inbox-list">
        <div class="inbox-row" onclick="document.getElementById('inbox-list').style.display='none'; document.getElementById('inbox-message').style.display='block';">
          <span class="avatar">F</span>
          <div style="flex:1;">
            <div style="display:flex; justify-content:space-between; gap:10px;">
              <strong>Fireflies</strong>
              <span class="muted small">Just now</span>
            </div>
            <div>${count} open commitment${count === 1 ? '' : 's'}</div>
            <div class="muted small">Click to open →</div>
          </div>
        </div>
      </div>
      <div id="inbox-message" style="display:none; padding:20px;">
        <button class="link-btn" type="button" onclick="document.getElementById('inbox-list').style.display='block'; document.getElementById('inbox-message').style.display='none';">← Back to inbox</button>
        <div style="margin:14px 0; padding-bottom:14px; border-bottom:1px solid var(--border);">
          <div><strong>Fireflies</strong> <span class="muted small">&lt;bot@fireflies-prototype.test&gt;</span></div>
          <div class="muted small">to ${esc(ownerEmail)}</div>
          <h3 style="margin:10px 0 0;">${count} open commitment${count === 1 ? '' : 's'}</h3>
        </div>
        ${messageRows}
      </div>
    </div>
    <p style="margin-top:18px;"><a href="/?view=${esc(view)}" style="color:var(--purple); font-weight:600;">← Back to Tasks</a></p>
  </div>
</body>
</html>`;
}

app.get('/inbox', (req, res) => {
  const ownerEmail = req.query.owner_email;
  const view = req.query.view === 'mine' ? 'mine' : 'all';
  if (!ownerEmail) return res.redirect(`/?view=${view}`);
  const state = loadState();
  const items = buildDigestPreview(state, ownerEmail);
  res.send(renderInboxPage(ownerEmail, items, view));
});

// ---- POST /tasks : create a commitment for testing — text + assignee email
// required, status always starts 'open'. Meeting is free text: typing a name
// that doesn't exist yet is how a "new meeting" gets created, since meetings
// aren't a separate stored entity, just a grouping label on commitments.
// body: { text, assignee_email, meeting?, return_view? }
app.post('/tasks', (req, res) => {
  const { text, assignee_email, meeting, return_view } = req.body;
  const view = return_view === 'mine' ? 'mine' : 'all';
  if (!text || !assignee_email) {
    return res.status(400).send('text and assignee_email are required');
  }

  const state = loadState();
  const id = 'c_' + Date.now();
  const createdAt = Date.now();
  const commitment = {
    text,
    meeting: meeting || 'Fireflies AI',
    status: 'open',
    ownerEmail: assignee_email,
    createdAt,
    updatedAt: createdAt,
    history: [],
  };
  pushHistory(commitment, 'open');
  state[id] = commitment;
  saveState(state);

  res.redirect(`/?created=1&view=${view}`);
});

// ---- POST /commitments/:id/status : manual status edit from the homepage,
// separate from the token-based /confirm flow. Lets you set a commitment
// straight to open/done/not_doing for testing, with a reason if dropping it.
// body: { status, reason?, return_view? }
app.post('/commitments/:id/status', (req, res) => {
  const { status, reason, return_view } = req.body;
  const view = return_view === 'mine' ? 'mine' : 'all';
  if (!['open', 'done', 'not_doing'].includes(status)) {
    return res.status(400).send('invalid status');
  }

  const state = loadState();
  const commitment = state[req.params.id];
  if (!commitment || !commitment.status) return res.status(404).send('not found');

  commitment.status = status;
  commitment.updatedAt = Date.now();
  if (status === 'not_doing' && reason) commitment.reason = reason;
  else delete commitment.reason;
  pushHistory(commitment, status, status === 'not_doing' && reason ? { reason } : {});
  saveState(state);

  res.redirect(`/?view=${view}&updated=${encodeURIComponent(req.params.id)}`);
});

// ---- POST /trigger : simulates the weekly digest — sends every currently-open
// commitment tagged to owner_email, exactly as they already exist in state.json.
// This never creates or edits commitments; state is updated by hand (see seed.js)
// since there's no real extraction pipeline behind this prototype.
// body: { owner_email }
app.post('/trigger', async (req, res) => {
  const { owner_email, return_view } = req.body;
  const wantsJson = (req.headers['content-type'] || '').includes('application/json');
  const view = return_view === 'mine' ? 'mine' : 'all';
  if (!owner_email) {
    return wantsJson ? res.status(400).json({ ok: false, error: 'owner_email is required' })
                      : res.status(400).send('owner_email is required');
  }

  const state = loadState();
  const open = openCommitmentsFor(state, owner_email);
  if (!open.length) {
    return wantsJson
      ? res.json({ ok: true, sent: false, reason: 'no_open_commitments' })
      : res.redirect(`/?empty=1&to=${encodeURIComponent(owner_email)}&view=${view}`);
  }

  const rows = open.map(c => {
    const actions = ['done', 'not_doing'];
    const links = {};
    actions.forEach(a => {
      const token = uuid();
      state[token] = { commitment_id: c.id, action: a, used: false };
      links[a] = `${BASE_URL}/confirm?token=${token}`;
    });
    return `
      <p style="margin:0 0 4px"><strong>${c.text}</strong><br/>
      <span style="color:#666;font-size:13px">${c.meeting}</span></p>
      <p style="margin:0 0 16px">
        <a href="${links.done}">Done</a> &nbsp;·&nbsp;
        <a href="${links.not_doing}">Not doing</a>
      </p>`;
  }).join('<hr style="border:none;border-top:1px solid #eee"/>');

  // Real delivery only works for this one Resend-verified demo address (see
  // README — a sandbox sender without a verified domain can't deliver to
  // arbitrary recipients, confirmed via testing). Anyone else trying "Send
  // digest" would just hit that same rejection, which doesn't actually
  // demonstrate anything — so for any other address, skip the real send
  // attempt and drop the digest into a simulated inbox instead, where the
  // exact same confirm links are fully clickable. The resolve mechanism
  // doesn't care how a token URL was obtained, only that it's valid.
  const isDemoRecipient = owner_email.trim().toLowerCase() === DEMO_RECIPIENT;

  if (isDemoRecipient) {
    // Written to disk only after a successful send — a failed send
    // shouldn't leave behind tokens for an email nobody actually received.
    try {
      await sendEmail({
        to: owner_email,
        subject: `${open.length} open commitment${open.length > 1 ? 's' : ''}`,
        html: rows,
      });
    } catch (err) {
      console.error('sendEmail failed:', err.message);
      return wantsJson
        ? res.status(502).json({ ok: false, error: err.message })
        : res.status(502).send(`<p>Couldn't send the digest: ${esc(err.message)}</p><p><a href="/?view=${view}">Back to Tasks</a></p>`);
    }

    saveState(state);

    return wantsJson
      ? res.json({ ok: true, sent: true, sent_to: owner_email, count: open.length })
      : res.redirect(`/?sent=1&count=${open.length}&to=${encodeURIComponent(owner_email)}&view=${view}`);
  }

  saveState(state);

  return wantsJson
    ? res.json({ ok: true, sent: 'simulated', sent_to: owner_email, count: open.length })
    : res.redirect(`/inbox?owner_email=${encodeURIComponent(owner_email)}&view=${view}`);
});

// ---- GET /confirm : landing page. For "not_doing", show reason chips + optional notify field. ----
app.get('/confirm', (req, res) => {
  const { token } = req.query;
  const state = loadState();
  const entry = state[token];

  if (!entry) return res.redirect('/?view=mine&confirm=invalid');

  const commitment = state[entry.commitment_id];
  if (entry.used || (commitment && commitment.status !== 'open')) {
    return res.redirect('/?view=mine&confirm=already_handled');
  }

  // No visible confirm step for either action — the form submits itself the
  // instant this page loads. A mail-security scanner prefetching the GET
  // link never executes this script, so it can't trigger the write; only a
  // real browser rendering the page does. To the human, it's a single click.
  // "Not doing" no longer prompts for a reason here — it defaults silently
  // to "prefer not to say" (an empty reason). Picking a specific reason is
  // still possible from the Tasks page's own status dropdown.
  const label = entry.action.replace('_', ' ');
  return res.send(renderStandalone(`
    <h2 style="margin-top:0;">Marking as ${esc(label)}…</h2>
    <div class="confirm-preview">
      <div class="confirm-preview-text">${esc(commitment.text)}</div>
      <div class="muted small">${esc(commitment.meeting)}</div>
    </div>
    <form id="auto-confirm" method="POST" action="/confirm">
      <input type="hidden" name="token" value="${esc(token)}" />
      <noscript><button class="btn btn-primary" type="submit" style="width:100%; margin-top:18px;">Confirm ${esc(label)}</button></noscript>
    </form>
    <script>document.getElementById('auto-confirm').submit();</script>
  `));
});

// ---- POST /confirm : the actual state write ----
app.post('/confirm', async (req, res) => {
  const { token, reason } = req.body;
  const state = loadState();
  const entry = state[token];

  if (!entry) return res.redirect('/?view=mine&confirm=invalid');

  const commitment = state[entry.commitment_id];
  if (entry.used || (commitment && commitment.status !== 'open')) {
    return res.redirect('/?view=mine&confirm=already_handled');
  }

  entry.used = true;
  commitment.status = entry.action;
  commitment.updatedAt = Date.now();
  if (entry.action === 'not_doing' && reason) commitment.reason = reason;
  pushHistory(commitment, entry.action, entry.action === 'not_doing' && reason ? { reason } : {});
  saveState(state);

  const remaining = listCommitments(state).filter(c => c.ownerEmail === commitment.ownerEmail && c.status === 'open').length;
  const params = new URLSearchParams({ confirm: 'done', status: entry.action, view: 'mine', remaining: String(remaining), updated: entry.commitment_id });
  if (reason) params.set('reason', reason);
  res.redirect(`/?${params.toString()}`);
});

// ================= HOMEPAGE : Fireflies-styled tasks view, backed by the same state =================

const STATUS_META = {
  open:       { label: 'Open',           class: 'status-open' },
  done:       { label: '✅ Done',        class: 'status-done' },
  not_doing:  { label: '🚫 Not doing',   class: 'status-not_doing' },
};

const REASON_LABELS = {
  deprioritized: 'Deprioritized',
  no_longer_needed: 'No longer needed',
  blocked: 'Blocked',
  '': 'Prefer not to say',
};

const HISTORY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>';

// Deterministic color per assignee email, so the same person always gets the
// same tag color across reloads and both tabs, without storing anything.
const TAG_PALETTE = [
  { bg: '#fde7e9', fg: '#c2445a' },
  { bg: '#e1f5f5', fg: '#0e7c86' },
  { bg: '#fce4f1', fg: '#c23e86' },
  { bg: '#eaf6e3', fg: '#4c8a2e' },
  { bg: '#fff3d6', fg: '#a9720f' },
  { bg: '#e7e2fb', fg: '#5b4cdb' },
  { bg: '#e0f0ff', fg: '#2264b3' },
  { bg: '#f5e6ff', fg: '#8a3fc4' },
];
function tagColor(email) {
  const s = email || 'unassigned';
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[hash % TAG_PALETTE.length];
}

const STATUS_COLORS = {
  open:      { bg: '#e8f0ff', fg: '#3b6fe0' },
  done:      { bg: '#e3f8ec', fg: '#22a55a' },
  not_doing: { bg: '#fdeaec', fg: '#d64158' },
};

function agingLabel(createdAt) {
  const ms = Math.max(0, Date.now() - (createdAt || Date.now()));
  const totalHours = Math.floor(ms / 3600000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${hours}h`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// Shared client-side logic for the weekly-digest opt-in preference. Uses
// localStorage, not sessionStorage — sessionStorage is scoped per browser
// tab, and every link clicked from an email opens in a new tab, so it never
// actually stayed dismissed across the clicks it needed to. localStorage is
// shared across tabs (and survives closing the browser), so "seen it, stop
// asking" holds until you explicitly turn it back off from Settings. Any
// page can render a toggle with class="digest-toggle-input" and it'll stay
// in sync; only the My Tasks page also gets the auto-popup (autoPromptOnLoad)
// and its modal markup.
// Viewer identity: no login, so on first visit (no cookie yet) every page
// blocks with a modal asking "what's your email" — that's what makes My
// Tasks mean anything per-visitor instead of a single hardcoded fixture.
// A plain cookie (not localStorage) because the server needs to read it too,
// to decide server-side which commitments are "yours" before it even renders
// the page.
const IDENTITY_MODAL_HTML = `
  <div class="modal-backdrop" id="identity-modal-backdrop">
    <div class="modal-card">
      <div class="modal-title">What's your email?</div>
      <div class="modal-desc">So My Tasks can show what's actually assigned to you.</div>
      <input class="field" type="email" id="identity-email-input" placeholder="you@example.com" style="margin-bottom:14px;" onkeydown="if (event.key === 'Enter') saveIdentityEmail();" />
      <button class="btn btn-primary" type="button" style="width:100%;" onclick="saveIdentityEmail()">Continue</button>
    </div>
  </div>
`;

function identityScript(viewerEmail) {
  return `
    const VIEWER_EMAIL = ${JSON.stringify(viewerEmail)};
    function saveIdentityEmail() {
      const input = document.getElementById('identity-email-input');
      const val = input.value.trim();
      if (!val) { input.focus(); return; }
      document.cookie = 'fireflies_me=' + encodeURIComponent(val) + '; path=/; max-age=' + (60 * 60 * 24 * 365);
      location.reload();
    }
    function changeIdentity() {
      document.cookie = 'fireflies_me=; path=/; max-age=0';
      location.reload();
    }
    if (!VIEWER_EMAIL) {
      document.getElementById('identity-modal-backdrop').classList.add('open');
    }
  `;
}

function digestOptInScript(autoPromptOnLoad) {
  return `
    const AUTO_PROMPT = ${JSON.stringify(!!autoPromptOnLoad)};
    const DIGEST_KEY = 'fireflies_digest_optin';
    const PROMPTED_KEY = 'fireflies_digest_prompted';
    function isDigestOptedIn() { return localStorage.getItem(DIGEST_KEY) === 'true'; }
    function hasBeenPrompted() { return localStorage.getItem(PROMPTED_KEY) === 'true'; }
    function syncDigestToggles() {
      const on = isDigestOptedIn();
      document.querySelectorAll('.digest-toggle-input').forEach(el => { el.checked = on; });
    }
    function openDigestModal() {
      const b = document.getElementById('digest-modal-backdrop');
      if (b) b.classList.add('open');
      localStorage.setItem(PROMPTED_KEY, 'true');
    }
    function closeDigestModal() { const b = document.getElementById('digest-modal-backdrop'); if (b) b.classList.remove('open'); }
    function onDigestToggle(el) {
      localStorage.setItem(DIGEST_KEY, el.checked ? 'true' : 'false');
      syncDigestToggles();
      // Toggling off is an explicit ask to be reminded again — bypasses the
      // "already prompted this session" gate that otherwise stops the popup
      // from reappearing on every subsequent page landing.
      if (el.checked) closeDigestModal();
      else if (AUTO_PROMPT) openDigestModal();
    }
    function tryCloseDigestModal() {
      if (isDigestOptedIn()) { closeDigestModal(); return; }
      const skip = confirm("Weekly digests give you closure on what's still open — skip for now?");
      if (skip) closeDigestModal();
    }
    syncDigestToggles();
    // Auto-show once per session — not on every landing on My Tasks, which
    // now happens after every single email action (Done/Not doing redirect
    // here). Re-toggling off from Settings still forces it back open.
    if (AUTO_PROMPT && !isDigestOptedIn() && !hasBeenPrompted()) openDigestModal();
  `;
}

function renderTasksPage(state, { banner, view = 'all', justUpdatedId = null, viewerEmail = null } = {}) {
  const isMine = view === 'mine';
  const allCommitments = listCommitments(state);
  const meetingNames = [...new Set(allCommitments.map(c => c.meeting || 'Fireflies AI'))].sort();
  const commitments = allCommitments
    .filter(c => !isMine || c.ownerEmail === viewerEmail)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const openCount = commitments.filter(c => c.status === 'open').length;
  const groups = new Map();
  for (const c of commitments) {
    const key = c.meeting || 'Fireflies AI';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const groupsHtml = groups.size ? [...groups.entries()].map(([meeting, rows]) => `
    <div class="card group-card">
      <div class="group-header">
        <span class="avatar">M</span>
        <div class="group-meta">
          <div class="group-title">${esc(meeting)}</div>
          <div class="group-sub">${rows.length} commitment${rows.length === 1 ? '' : 's'}</div>
        </div>
        <span class="group-count">${rows.length} Tasks</span>
      </div>
      ${rows.map(c => {
        const color = tagColor(c.ownerEmail);
        const showReason = c.status === 'not_doing';
        const isJustUpdated = c.id === justUpdatedId;
        return `
        <div class="task-row ${c.status === 'open' ? 'task-row-open' : ''} ${isJustUpdated ? 'task-row-updated' : ''}">
          <span class="checkbox" ${c.status === 'done' ? 'style="background:var(--green-ink);border-color:var(--green-ink);"' : ''}></span>
          <div class="task-text ${c.status === 'done' || c.status === 'not_doing' ? 'done' : ''}">
            ${esc(c.text)}
            ${c.status === 'open' ? `<span class="aging-badge">${agingLabel(c.createdAt)} open</span>` : ''}
            ${isJustUpdated ? `<span class="just-updated-badge">✓ Just updated</span>` : ''}
          </div>
          <span class="tag" style="background:${color.bg}; color:${color.fg};">
            <span class="tag-avatar" style="background:${color.fg};">${esc((c.ownerEmail || '?')[0].toUpperCase())}</span>${esc(c.ownerEmail || 'unassigned')}
          </span>
          <form class="status-form" method="POST" action="/commitments/${esc(c.id)}/status">
            <input type="hidden" name="return_view" value="${isMine ? 'mine' : 'all'}" />
            <select class="field status-select" name="status"
              style="background:${STATUS_COLORS[c.status].bg}; color:${STATUS_COLORS[c.status].fg}; border-color:${STATUS_COLORS[c.status].bg}; font-weight:600;"
              onchange="this.style.background=({open:'${STATUS_COLORS.open.bg}',done:'${STATUS_COLORS.done.bg}',not_doing:'${STATUS_COLORS.not_doing.bg}'})[this.value]; this.style.color=({open:'${STATUS_COLORS.open.fg}',done:'${STATUS_COLORS.done.fg}',not_doing:'${STATUS_COLORS.not_doing.fg}'})[this.value]; this.closest('form').querySelector('.reason-select').style.display = this.value === 'not_doing' ? '' : 'none'; this.form.submit();">
              <option value="open" ${c.status === 'open' ? 'selected' : ''}>Open</option>
              <option value="done" ${c.status === 'done' ? 'selected' : ''}>Done</option>
              <option value="not_doing" ${c.status === 'not_doing' ? 'selected' : ''}>Not doing</option>
            </select>
            <select class="field reason-select" name="reason" style="${showReason ? '' : 'display:none;'}" onchange="this.form.submit();">
              ${Object.entries(REASON_LABELS).map(([val, label]) => `<option value="${val}" ${(c.reason || '') === val ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </form>
          <button class="icon-btn" type="button" onclick="openHistory('${esc(c.id)}')" title="History">${HISTORY_ICON}</button>
        </div>`;
      }).join('')}
    </div>
  `).join('') : `<div class="card group-card"><div class="empty-note">${
    isMine
      ? (viewerEmail ? `No commitments assigned to ${esc(viewerEmail)}.` : 'Enter your email to see what’s assigned to you.')
      : 'No commitments yet.'
  }</div></div>`;

  const historyMap = {};
  for (const c of commitments) {
    historyMap[c.id] = {
      text: c.text,
      createdAt: c.createdAt,
      history: Array.isArray(c.history) && c.history.length ? c.history : [{ status: 'open', at: c.createdAt }],
    };
  }
  const historyJson = JSON.stringify(historyMap).replace(/</g, '\\u003c');
  const toastJson = JSON.stringify(banner || null).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Tasks — Fireflies</title>
<style>${FIREFLIES_CSS}</style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-user"><span class="avatar">${viewerEmail ? esc(viewerEmail[0].toUpperCase()) : '?'}</span> ${viewerEmail ? esc(viewerEmail) : 'Not set'}</div>
      <a class="nav-item" href="#">Home</a>
      <a class="nav-item" href="#">AskFred</a>
      <a class="nav-item" href="#">Meetings</a>
      <a class="nav-item active" href="/">Tasks</a>
      <a class="nav-item" href="#">AI Skills</a>
      <a class="nav-item" href="#">Analytics</a>
      <a class="nav-item" href="#">Voice Agents</a>
      <div class="sidebar-spacer"></div>
      <a class="nav-item" href="#">Integrations</a>
      <a class="nav-item" href="/settings">Settings</a>
    </aside>
    <div class="main">
      <div class="trial-banner">You have 6 days left in your business plan free trial. <a href="#">Subscribe now →</a></div>
      <div class="topbar">
        <div class="topbar-title">Tasks</div>
        <div class="search">Search by title or keyword <span class="muted small">Ctrl+K</span></div>
        <div class="topbar-actions"><button class="btn btn-primary">⏺ Capture ▾</button></div>
      </div>
      <div class="content">
        <div class="tabs-row">
          <div class="pill-tabs">
            <a class="pill-tab ${isMine ? 'active' : ''}" href="/?view=mine">My Tasks</a>
            <a class="pill-tab ${isMine ? '' : 'active'}" href="/?view=all">All Tasks</a>
          </div>
          <div style="display:flex; align-items:center; gap:18px;">
            <form method="POST" action="/trigger" class="digest-inline-form" title="Sends every currently-open commitment tagged to this email as one digest — nothing is created here.">
              <input type="hidden" name="return_view" value="${isMine ? 'mine' : 'all'}" />
              <input class="field" type="email" name="owner_email" placeholder="you@example.com" value="${esc(viewerEmail || '')}" required />
              <button class="btn btn-primary" type="submit">Send digest</button>
            </form>
          </div>
        </div>
        <div class="card open-summary-card">
          <div class="icon-tile" style="background:var(--amber-tint); font-size:16px;">📂</div>
          <div><strong>${openCount}</strong> of ${commitments.length} commitments still open</div>
        </div>
        ${groupsHtml}

        <div class="section-label"><span>New task (for testing)</span></div>
        <div class="card" style="padding:20px;">
          <form method="POST" action="/tasks">
            <p class="muted small" style="margin-top:0;">
              Creates a commitment directly, status always starts Open. Type an
              existing meeting name to add to it, or a new one to create it.
            </p>
            <input type="hidden" name="return_view" value="${isMine ? 'mine' : 'all'}" />
            <p><input class="field" name="text" placeholder="Task text" required /></p>
            <p><input class="field" type="email" name="assignee_email" placeholder="assignee@example.com" required /></p>
            <p>
              <input class="field" name="meeting" placeholder="Meeting (optional — defaults to Fireflies AI)" list="meeting-options" />
              <datalist id="meeting-options">
                ${meetingNames.map(m => `<option value="${esc(m)}"></option>`).join('')}
              </datalist>
            </p>
            <button class="btn btn-primary" type="submit">Create task</button>
          </form>
        </div>
      </div>
    </div>
  </div>

  <div class="drawer-backdrop" id="drawer-backdrop" onclick="closeHistory()"></div>
  <div class="drawer" id="drawer">
    <div class="drawer-header">
      <div>
        <div class="drawer-title">History</div>
        <div class="muted small" id="drawer-task-text"></div>
      </div>
      <button class="drawer-close" onclick="closeHistory()" aria-label="Close">×</button>
    </div>
    <div class="drawer-body" id="drawer-body"></div>
  </div>

  <div class="toast" id="toast"></div>

  ${IDENTITY_MODAL_HTML}

  ${isMine ? `
  <div class="modal-backdrop" id="digest-modal-backdrop" onclick="if (event.target === this) tryCloseDigestModal();">
    <div class="modal-card">
      <button class="modal-close" type="button" onclick="tryCloseDigestModal()" aria-label="Close">×</button>
      <div class="modal-title">Get a weekly digest?</div>
      <div class="modal-desc">One email a week listing everything still open — nothing more to do than glance at it.</div>
      <label class="toggle-row">
        <span class="toggle-label">Email me a weekly digest</span>
        <span class="toggle">
          <input type="checkbox" class="digest-toggle-input" onchange="onDigestToggle(this)" />
          <span class="toggle-slider"></span>
        </span>
      </label>
    </div>
  </div>` : ''}

  <script>
    const TOAST_MESSAGE = ${toastJson};
    if (TOAST_MESSAGE) {
      const toast = document.getElementById('toast');
      toast.textContent = TOAST_MESSAGE;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3000);
      // Strip the one-off result params from the URL so a plain browser
      // refresh doesn't re-fire the same toast on every reload.
      const url = new URL(location.href);
      ['sent', 'count', 'to', 'empty', 'created', 'confirm', 'status', 'reason', 'remaining', 'updated'].forEach(p => url.searchParams.delete(p));
      history.replaceState(null, '', url.pathname + url.search);
    }

    ${identityScript(viewerEmail)}
    ${digestOptInScript(isMine && !!viewerEmail)}

    const HISTORY = ${historyJson};
    const STATUS_LABELS = ${JSON.stringify(Object.fromEntries(Object.entries(STATUS_META).map(([k, v]) => [k, v.label])))};
    function fmt(ts) { return ts ? new Date(ts).toLocaleString() : ''; }
    function openHistory(id) {
      const data = HISTORY[id];
      if (!data) return;
      document.getElementById('drawer-task-text').textContent = data.text;
      document.getElementById('drawer-body').innerHTML =
        '<div class="muted small" style="margin-bottom:14px;">Created ' + fmt(data.createdAt) + '</div>' +
        data.history.map(h => (
          '<div class="history-item"><span class="history-dot"></span><div>' +
          '<div class="history-status">' + (STATUS_LABELS[h.status] || h.status) + (h.reason ? ' · ' + h.reason.replace('_', ' ') : '') + '</div>' +
          '<div class="history-date muted small">' + fmt(h.at) + '</div>' +
          '</div></div>'
        )).join('');
      document.getElementById('drawer').classList.add('open');
      document.getElementById('drawer-backdrop').classList.add('open');
    }
    function closeHistory() {
      document.getElementById('drawer').classList.remove('open');
      document.getElementById('drawer-backdrop').classList.remove('open');
    }
  </script>
</body>
</html>`;
}

// ================= SETTINGS : where the weekly-digest toggle actually lives =================
// Styled after the real Fireflies Settings screen (Personal/Team tabs, a
// category sub-nav, section cards with icon/title/description/control rows).
// The digest toggle is Personal-only, matching how it's a per-viewer
// preference, not something a team-wide settings tab would hold.
function renderSettingsPage({ tab = 'personal', viewerEmail = null } = {}) {
  const isPersonal = tab !== 'team';

  const accountCard = `
    <div class="section-label"><span>Account</span></div>
    <div class="card settings-card">
      <div class="settings-row">
        <div class="icon-tile settings-icon">👤</div>
        <div class="settings-row-text">
          <div class="settings-row-title">Your email</div>
          <div class="muted small">${viewerEmail ? esc(viewerEmail) : 'Not set yet'} — this is what My Tasks filters by.</div>
        </div>
        <button class="btn" type="button" onclick="changeIdentity()">Change</button>
      </div>
    </div>
  `;

  const notificationsCard = `
    <div class="section-label"><span>Notifications</span></div>
    <div class="card settings-card">
      <div class="settings-row">
        <div class="icon-tile settings-icon">🔔</div>
        <div class="settings-row-text">
          <div class="settings-row-title">Weekly digest</div>
          <div class="muted small">A Monday-morning email listing everything still open — nothing more to do than glance at it.</div>
        </div>
        <label class="toggle">
          <input type="checkbox" class="digest-toggle-input" onchange="onDigestToggle(this)" />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  `;

  const teamEmptyCard = `
    <div class="section-label"><span>Team</span></div>
    <div class="card settings-card">
      <div class="empty-note">No team-level settings in this prototype.</div>
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Settings — Fireflies</title>
<style>${FIREFLIES_CSS}</style>
</head>
<body>
  <div class="trial-banner">You have 6 days left in your business plan free trial. <a href="#">Subscribe now →</a></div>
  <div class="settings-topbar">
    <a href="/" class="icon-btn" aria-label="Back" style="font-size:18px;">←</a>
    <div class="search" style="margin:0;">Search settings</div>
    <a href="#" class="link-btn">💬 Feedback</a>
  </div>
  <div class="settings-shell">
    <aside class="settings-sidebar">
      <div class="settings-user">
        <span class="avatar">${viewerEmail ? esc(viewerEmail[0].toUpperCase()) : '?'}</span>
        <div>
          <div class="settings-user-email">${viewerEmail ? esc(viewerEmail) : 'Not set'}</div>
          <div class="muted small">Business Plan</div>
        </div>
      </div>
      <div class="pill-tabs" style="margin-bottom:16px;">
        <a class="pill-tab ${isPersonal ? 'active' : ''}" href="/settings?tab=personal">Personal</a>
        <a class="pill-tab ${isPersonal ? '' : 'active'}" href="/settings?tab=team">Team</a>
      </div>
      <div class="settings-nav-item active">🔔 Notifications</div>
      <div class="settings-nav-item">🎥 Recording &amp; Privacy</div>
      <div class="settings-nav-item">✉️ Email Assistant</div>
      <div class="settings-nav-item">✨ AI Settings</div>
      <div class="settings-nav-item">📖 Knowledge Base</div>
    </aside>
    <div class="settings-content">
      ${isPersonal ? accountCard + notificationsCard : teamEmptyCard}
    </div>
  </div>

  ${IDENTITY_MODAL_HTML}

  <script>
    ${identityScript(viewerEmail)}
    ${digestOptInScript(false)}
  </script>
</body>
</html>`;
}

app.get('/settings', (req, res) => {
  const viewerEmail = parseCookies(req).fireflies_me || null;
  res.send(renderSettingsPage({ tab: req.query.tab === 'team' ? 'team' : 'personal', viewerEmail }));
});

const FIREFLIES_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
:root {
  --purple:#5b4cdb; --purple-tint:#f0edfc;
  --green-tint:#e3f8ec; --green-ink:#22a55a;
  --amber-tint:#fff3e0; --amber-ink:#c8790a;
  --red-tint:#fdeaec; --red-ink:#d64158;
  --blue-tint:#e8f0ff; --blue-ink:#3b6fe0;
  --purple-tint-2:#e7e2fb;
  --page-bg:#f6f6fa; --card-bg:#fff; --border:#eaeaf1;
  --ink:#181a20; --ink-soft:#6f7280; --ink-faint:#9799a6;
  --radius-lg:16px; --radius-sm:8px;
  --shadow-card:0 1px 2px rgba(20,20,40,.04),0 1px 8px rgba(20,20,40,.03);
}
* { box-sizing:border-box; }
body { margin:0; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--page-bg); color:var(--ink); font-size:14px; }
a { color:inherit; text-decoration:none; }
.app-shell { display:flex; min-height:100vh; }
.sidebar { width:220px; flex-shrink:0; background:var(--card-bg); border-right:1px solid var(--border); display:flex; flex-direction:column; padding:16px 12px; position:sticky; top:0; height:100vh; overflow-y:auto; }
.sidebar-user { display:flex; align-items:center; gap:8px; padding:6px 8px 18px; font-weight:600; }
.avatar { width:26px; height:26px; border-radius:8px; background:var(--purple); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; flex-shrink:0; }
.nav-item { display:block; padding:9px 10px; border-radius:var(--radius-sm); color:var(--ink-soft); font-weight:500; margin-bottom:2px; }
.nav-item.active { background:var(--purple-tint); color:var(--purple); }
.sidebar-spacer { flex:1; }
.main { flex:1; min-width:0; display:flex; flex-direction:column; }
.trial-banner { background:linear-gradient(90deg,#eef1fd,#fbeef8); text-align:center; padding:8px; font-size:12.5px; color:var(--ink-soft); }
.trial-banner a { color:var(--purple); font-weight:600; }
.topbar { display:flex; align-items:center; justify-content:space-between; padding:14px 28px; border-bottom:1px solid var(--border); background:var(--card-bg); }
.topbar-title { font-size:15px; font-weight:600; }
.search { flex:1; max-width:420px; margin:0 24px; background:var(--page-bg); border-radius:999px; padding:8px 14px; color:var(--ink-faint); font-size:13px; display:flex; justify-content:space-between; }
.btn { border-radius:var(--radius-sm); padding:8px 14px; font-size:13px; font-weight:600; border:1px solid var(--border); background:var(--card-bg); cursor:pointer; }
.btn-primary { background:var(--ink); color:#fff; border-color:var(--ink); }
.content { padding:24px 28px 40px; max-width:900px; }
.pill-tabs { display:inline-flex; background:var(--page-bg); border-radius:999px; padding:3px; gap:2px; }
.pill-tab { padding:6px 16px; border-radius:999px; font-weight:600; font-size:13px; color:var(--ink-soft); }
.pill-tab.active { background:var(--card-bg); color:var(--ink); box-shadow:var(--shadow-card); }
.card { background:var(--card-bg); border:1px solid var(--border); border-radius:var(--radius-lg); box-shadow:var(--shadow-card); }
.group-card { margin-top:18px; }
.group-header { display:flex; align-items:center; gap:12px; padding:16px 20px; border-bottom:1px solid var(--border); }
.group-meta { flex:1; }
.group-title { font-weight:600; }
.group-sub { color:var(--ink-faint); font-size:12.5px; margin-top:2px; }
.group-count { font-size:12.5px; color:var(--ink-soft); font-weight:600; background:var(--page-bg); padding:5px 10px; border-radius:999px; }
.task-row { display:flex; align-items:flex-start; gap:12px; padding:14px 20px; border-bottom:1px solid var(--border); }
.task-row:last-child { border-bottom:none; }
.task-row-open { background:#fffbea; border-left:3px solid #f2c94c; padding-left:17px; }

.open-summary-card { display:flex; align-items:center; gap:12px; padding:14px 18px; margin-bottom:8px; font-size:13.5px; }

@keyframes row-pulse { 0% { box-shadow:0 0 0 0 rgba(91,76,219,.35); } 70% { box-shadow:0 0 0 10px rgba(91,76,219,0); } 100% { box-shadow:0 0 0 0 rgba(91,76,219,0); } }
.task-row-updated { animation:row-pulse 1.1s ease-out 2; position:relative; z-index:1; }
.just-updated-badge { display:inline-flex; align-items:center; gap:4px; background:var(--purple-tint); color:var(--purple); font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; margin-left:8px; opacity:1; animation:fade-out-badge .4s ease 4s forwards; }
@keyframes fade-out-badge { to { opacity:0; } }
.checkbox { width:18px; height:18px; border-radius:5px; border:1.5px solid #d3d4dd; margin-top:1px; flex-shrink:0; }
.task-text { flex:1; line-height:1.5; }
.task-text.done { text-decoration:line-through; color:var(--ink-faint); }
.tag { display:inline-flex; align-items:center; gap:6px; padding:3px 10px 3px 3px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap; background:var(--purple-tint-2); color:var(--purple); }
.tag .tag-avatar { width:20px; height:20px; border-radius:6px; display:inline-flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; color:#fff; background:var(--purple); }
.status { display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border-radius:999px; font-size:12px; font-weight:700; white-space:nowrap; }
.status-open { background:var(--blue-tint); color:var(--blue-ink); }
.status-done { background:var(--green-tint); color:var(--green-ink); }
.status-not_doing { background:var(--red-tint); color:var(--red-ink); }
.section-label { margin:28px 0 12px; font-weight:600; }
.empty-note { text-align:center; color:var(--ink-faint); font-size:13px; padding:40px 0; }
.muted { color:var(--ink-faint); }
.small { font-size:12.5px; }

.field { display:block; width:100%; padding:9px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); font-family:inherit; font-size:13px; color:var(--ink); background:#fff; }
.field:focus { outline:none; border-color:var(--purple); box-shadow:0 0 0 3px var(--purple-tint); }
.field-label { font-weight:600; font-size:13px; margin:0 0 8px; }

.standalone-wrap { min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:32px 16px; }
.standalone-brand { display:flex; align-items:center; gap:8px; font-weight:700; font-size:15px; margin-bottom:18px; }
.standalone-card { width:100%; max-width:420px; padding:28px; }
.standalone-card h2 { font-size:18px; }

.confirm-preview { background:var(--page-bg); border-radius:var(--radius-sm); padding:14px 16px; margin-top:14px; }
.confirm-preview-text { font-weight:600; }

.chip-group { display:flex; flex-wrap:wrap; gap:8px; }
.chip { position:relative; display:inline-flex; align-items:center; gap:6px; padding:7px 14px; border:1px solid var(--border); border-radius:999px; font-size:13px; cursor:pointer; }
.chip input { position:absolute; opacity:0; width:0; height:0; }
.chip:has(input:checked) { border-color:var(--purple); background:var(--purple-tint); color:var(--purple); font-weight:600; }

.icon-btn { border:none; background:none; padding:4px; border-radius:6px; color:var(--ink-faint); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; align-self:center; flex-shrink:0; }
.icon-btn:hover { background:var(--page-bg); color:var(--ink-soft); }

.drawer-backdrop { position:fixed; inset:0; background:rgba(15,15,25,.28); opacity:0; pointer-events:none; transition:opacity .2s ease; z-index:40; }
.drawer-backdrop.open { opacity:1; pointer-events:auto; }
.drawer { position:fixed; top:0; right:0; height:100vh; width:360px; max-width:90vw; background:var(--card-bg); box-shadow:-8px 0 24px rgba(20,20,40,.12); transform:translateX(100%); transition:transform .25s ease; z-index:41; display:flex; flex-direction:column; }
.drawer.open { transform:translateX(0); }
.drawer-header { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:20px; border-bottom:1px solid var(--border); }
.drawer-title { font-weight:600; }
.drawer-close { border:none; background:none; font-size:18px; line-height:1; cursor:pointer; color:var(--ink-faint); padding:2px 6px; }
.drawer-body { padding:20px; overflow-y:auto; flex:1; }

.history-item { display:flex; gap:10px; padding-bottom:18px; position:relative; }
.history-item:not(:last-child)::before { content:''; position:absolute; left:5px; top:16px; bottom:0; width:1px; background:var(--border); }
.history-dot { width:11px; height:11px; border-radius:50%; background:var(--purple); margin-top:3px; flex-shrink:0; }
.history-status { font-weight:600; font-size:13px; }
.history-date { margin-top:2px; }

.tabs-row { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:16px; }
.digest-inline-form { display:flex; align-items:center; gap:8px; }
.digest-inline-form .field { width:200px; padding:7px 12px; }

.status-form { display:flex; align-items:center; gap:6px; flex-shrink:0; }
.status-select, .reason-select { width:auto; padding:5px 10px; font-size:12px; font-weight:600; cursor:pointer; }
.reason-select { color:var(--ink-soft); font-weight:500; background:var(--page-bg); }

.aging-badge { display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; background:var(--page-bg); color:var(--ink-faint); font-size:11px; font-weight:600; vertical-align:middle; }

.toast { position:fixed; bottom:28px; left:50%; transform:translateX(-50%) translateY(12px); background:var(--ink); color:#fff; padding:12px 20px; border-radius:var(--radius-sm); font-size:13px; font-weight:600; box-shadow:0 8px 24px rgba(20,20,40,.18); opacity:0; pointer-events:none; transition:opacity .2s ease, transform .2s ease; z-index:60; max-width:80vw; }
.toast.show { opacity:1; transform:translateX(-50%) translateY(0); }

.toggle { position:relative; display:inline-block; width:38px; height:21px; flex-shrink:0; }
.toggle input { opacity:0; width:0; height:0; position:absolute; }
.toggle-slider { position:absolute; inset:0; background:#d3d4dd; transition:.2s; border-radius:999px; cursor:pointer; }
.toggle-slider::before { content:''; position:absolute; height:15px; width:15px; left:3px; top:3px; background:#fff; transition:.2s; border-radius:50%; }
.toggle input:checked + .toggle-slider { background:var(--purple); }
.toggle input:checked + .toggle-slider::before { transform:translateX(17px); }

.modal-backdrop { position:fixed; inset:0; background:rgba(15,15,25,.35); display:flex; align-items:center; justify-content:center; z-index:70; opacity:0; pointer-events:none; transition:opacity .15s ease; }
.modal-backdrop.open { opacity:1; pointer-events:auto; }
.modal-card { background:var(--card-bg); border-radius:var(--radius-lg); box-shadow:0 20px 60px rgba(20,20,40,.25); width:100%; max-width:380px; padding:24px; position:relative; margin:16px; }
.modal-close { position:absolute; top:12px; right:14px; border:none; background:none; font-size:20px; line-height:1; cursor:pointer; color:var(--ink-faint); padding:2px 6px; }
.modal-title { font-weight:700; font-size:16px; margin:0 0 8px; padding-right:20px; }
.modal-desc { color:var(--ink-soft); font-size:13px; margin:0 0 20px; line-height:1.5; }
.toggle-row { display:flex; align-items:center; justify-content:space-between; gap:14px; cursor:pointer; }
.toggle-label { font-weight:600; font-size:13px; }

.link-btn { border:none; background:none; color:var(--purple); font-weight:600; font-size:13px; cursor:pointer; }

.settings-topbar { display:flex; align-items:center; gap:20px; padding:14px 28px; border-bottom:1px solid var(--border); background:var(--card-bg); }
.settings-topbar .search { flex:1; max-width:480px; margin:0 auto; }
.settings-shell { display:flex; max-width:1100px; margin:0 auto; }
.settings-sidebar { width:240px; flex-shrink:0; padding:24px 16px; }
.settings-user { display:flex; align-items:center; gap:10px; padding:4px 8px 20px; }
.settings-user-email { font-weight:600; font-size:13px; }
.settings-nav-item { padding:9px 10px; border-radius:var(--radius-sm); color:var(--ink-soft); font-weight:500; font-size:13.5px; margin-bottom:2px; }
.settings-nav-item.active { background:var(--purple-tint); color:var(--purple); font-weight:600; }
.settings-content { flex:1; padding:24px 28px 60px; }
.settings-card { padding:0; }
.settings-row { display:flex; align-items:flex-start; gap:14px; padding:18px 20px; }
.settings-row-text { flex:1; }
.settings-row-title { font-weight:600; margin-bottom:2px; }
.icon-tile { width:34px; height:34px; border-radius:10px; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; }
.settings-icon { font-size:16px; background:var(--purple-tint); }

.inbox-row { display:flex; align-items:center; gap:12px; padding:16px 20px; cursor:pointer; }
.inbox-row:hover { background:var(--page-bg); }
.inbox-commitment-row { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:14px 0; border-bottom:1px solid var(--border); }
.inbox-commitment-row:last-child { border-bottom:none; }
.inbox-commitment-text { font-weight:600; }
.inbox-commitment-actions { display:flex; gap:8px; flex-shrink:0; }
`;

app.get('/', (req, res) => {
  const state = loadState();
  const view = req.query.view === 'mine' ? 'mine' : 'all';
  // Rendered as a 3-second toast (see TOAST_MESSAGE in the page script) rather
  // than a persistent banner — these are one-off action confirmations, not
  // standing page state. Plain text is fine here: it's set via textContent,
  // never innerHTML, so no HTML-escaping is needed.
  let banner = null;
  if (req.query.sent === '1') banner = `Digest sent to ${req.query.to} — ${req.query.count} open commitment(s).`;
  else if (req.query.empty === '1') banner = `No open commitments for ${req.query.to} — nothing sent.`;
  else if (req.query.created === '1') banner = 'New task created.';
  else if (req.query.confirm === 'done') {
    const meta = STATUS_META[req.query.status];
    const label = meta ? meta.label : req.query.status;
    const remaining = Number(req.query.remaining || 0);
    const remainingText = remaining > 0 ? ` You have ${remaining} more open.` : ' Nothing else open right now.';
    banner = `Marked ${label}${req.query.reason ? ` (${String(req.query.reason).replace('_', ' ')})` : ''}.${remainingText}`;
  }
  else if (req.query.confirm === 'already_handled') banner = 'That commitment was already handled — no change made.';
  else if (req.query.confirm === 'invalid') banner = 'That link is invalid or has expired.';
  const justUpdatedId = typeof req.query.updated === 'string' ? req.query.updated : null;
  const viewerEmail = parseCookies(req).fireflies_me || null;
  res.send(renderTasksPage(state, { banner, view, justUpdatedId, viewerEmail }));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Email prototype listening on ${PORT}`));
