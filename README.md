# Fireflies commitment tracking — email prototype

Meeting commitments become tracked, one-tap-resolvable objects instead of
dying in a broadcast summary email — delivered as a digest email instead of
a Slack DM (the earlier Slack/OAuth prototype was dropped entirely for
build-cost reasons; nothing from it carries forward).

## What this is

- **Viewer identity** — no login, so on first visit any page blocks with a
  modal asking "what's your email?" The answer is remembered in a plain
  cookie (not `localStorage` — the server needs to read it too, to decide
  server-side which rows are "yours" before rendering). That's what makes
  **My Tasks** mean something different for each visitor: enter
  `mukundkorapati@gmail.com` and you see the commitments seeded for that
  address; a teammate entering `teammate@example.com` sees theirs; a brand
  new email sees nothing in My Tasks but everything in All Tasks, since that
  tab isn't filtered. Change it any time from Settings → Personal → Account.
- **`GET /`** — the homepage *is* the Fireflies Tasks screen, styled against
  the real Fireflies UI (palette, cards, status pills). It reads `state.json`
  directly and renders every commitment's live status (open / done / not
  doing), grouped by meeting, with **My Tasks** / **All Tasks** tabs and a
  **Send digest** control inline in that same top row, right-aligned.
  - Each assignee gets a deterministic tag color (hashed from their email),
    so distinct people are visually distinguishable in All Tasks.
  - Status is directly editable via a dropdown on each row (Open / Done /
    Not doing) — choosing Not doing reveals a second dropdown for the reason.
    This writes straight to `state.json` via `POST /commitments/:id/status`,
    independent of the token-based email flow below.
  - Open commitments show an aging badge ("2d 4h open") computed from
    `createdAt`, and the whole row gets a soft yellow highlight so anything
    still open is easy to spot at a glance — useful right after resolving
    one item from a multi-item digest, to catch any others still pending.
  - A small card under the tabs states "N of M [your/total] commitments
    still open" for whichever tab you're on — a persistent count, not just
    the toast, so it's still visible after the toast fades.
  - Whichever commitment was just resolved (via an email link or the status
    dropdown) gets a brief pulse animation and a "✓ Just updated" badge that
    fades after a few seconds — so landing back on a long task list after
    clicking an email button doesn't leave you hunting for which row changed.
  - Each row has a history icon that opens a drawer showing every status
    change with its timestamp, plus when the commitment was created.
  - Landing on **My Tasks** while not opted into the weekly digest pops up a
    prompt with a toggle, but only once, ever, per browser (`localStorage`,
    not `sessionStorage` — every link clicked from an email opens a new tab,
    which gets a blank `sessionStorage`, so that scope never actually stayed
    dismissed across the clicks it needed to). Opting in, or dismissing
    without opting in, both suppress it from auto-showing again on this
    browser. Toggling it back off from Settings is treated as an explicit
    request and always re-shows it immediately, bypassing that suppression.
- **`GET /settings`** — styled after the real Fireflies Settings screen
  (Personal/Team tabs, a category sub-nav, section cards). The weekly-digest
  toggle lives here under **Personal → Notifications** — Team has no such
  setting, since it's a per-viewer preference. Toggling it here or from the
  My Tasks popup stays in sync (same `localStorage` key, shared across
  tabs); toggling it off re-shows the popup next time you land on My Tasks.
- **`POST /tasks`** — creates a commitment for testing: `text` and
  `assignee_email` are required, status always starts `open`. `meeting` is
  free text — typing a name that doesn't exist yet is how a new meeting
  gets created, since meetings aren't a separate stored entity, just a
  grouping label on commitments.
- **`POST /trigger`** — simulates the weekly digest: sends every commitment
  already `open` and tagged to `owner_email`, exactly as it exists in
  `state.json`. It never creates or edits commitments — this is a pure send.
- **`GET /confirm`** — the landing page for a clicked email link, for either
  action. There's no visible confirmation step: the page's one form submits
  itself via a script the instant it loads, so a real click in the email
  feels instant. This still protects against link-prescanning (Microsoft
  Safe Links, Proofpoint, etc. auto-fetch every link in a scanned email) —
  those fetches are plain GET requests that never execute the page's script,
  so they can't trigger the write; only a real browser rendering the page
  does. Not doing no longer prompts for a reason via email — it silently
  defaults to "prefer not to say" (no reason stored). Picking a specific
  reason is still possible from the Tasks page's own status dropdown. An
  invalid or already-resolved token redirects straight to `/` instead of
  showing a dead-end page.
- **`POST /confirm`** — the actual state write. Always redirects to
  `/?view=mine` (not a static "you can close this tab" page), with a toast
  that also surfaces how many other commitments are still open for that
  owner — e.g. "Marked ✅ Done. You have 3 more open." — so resolving one
  item from a multi-item digest doesn't leave the rest silently forgotten.
- **Idempotency** — a token already used, or a commitment no longer `open`,
  redirects to `/?view=mine` with an "already handled" toast instead of
  reprocessing.

All of it reads and writes one flat file, `state.json`, keyed by both
commitment ids (`c_<timestamp>`, carrying `text`/`meeting`/`status`/
`ownerEmail`/`history`) and action tokens (uuids, carrying `commitment_id`/
`action`/`used`) in the same object — resolving something by email is
immediately visible the next time `/` is loaded, because both read the same
file. `history` is an array of `{ status, at, reason? }` entries, appended
to on creation and on every resolution — this is what the drawer renders.

## Running locally

```bash
npm install
cp .env.example .env   # fill in SMTP + BASE_URL, see below
node server.js
```

Open `http://localhost:3001/` — the server auto-seeds `state.json` with a
default 14-commitment dataset the first time it boots and finds no state
file (`seedData.js`, shared with the manual script below), so it's never
empty on a fresh clone or deploy. Enter `mukundkorapati@gmail.com` at the
identity prompt to see the pre-assigned My Tasks demo, or any other email to
explore from a different angle (see "Viewer identity" above).

To reset back to that default dataset at any point (e.g. after testing has
mutated it), run:

```bash
node seed.js
```

Use the **New task** form to create more commitments for testing (task text
+ assignee email required, meeting optional/free-text), and the **Send
digest** form to email every currently-open commitment tagged to an address
as one digest — it only takes an email, nothing is created by it.

The same trigger works headlessly:

```bash
curl http://localhost:3001/trigger -d "owner_email=you@example.com"
```

### Sending email: Resend vs. SMTP

`sendEmail()` in `server.js` prefers **Resend's HTTP API** whenever
`RESEND_API_KEY` is set, falling back to the SMTP transporter otherwise.
This isn't just a preference — several PaaS hosts, **Render included**,
silently block or drop outbound raw SMTP connections (port 587/465/25),
which surfaces as a `nodemailer` connection timeout with no other error.
HTTP-based providers send over port 443, which is never blocked.

- **Deployed (Render, etc.):** get a free key at [resend.com](https://resend.com)
  and set `RESEND_API_KEY`. No domain verification needed — it sends from
  `onboarding@resend.dev` to any recipient out of the box. Override the
  sender with `RESEND_FROM` if you verify your own domain later.
- **Local dev:** SMTP works fine, since this restriction is host-specific.
  `.env.example` defaults to Mailtrap's **sandbox** SMTP, which confirms
  sends work but captures mail into a Mailtrap test inbox rather than your
  real one. To actually receive it, use Gmail SMTP (`smtp.gmail.com:587`)
  with a Google **App Password** as `SMTP_PASS` — remove any spaces from
  the password Google shows you, it's really 16 characters with none.

`BASE_URL` must match whatever host is serving `/confirm` — `http://localhost:3001`
while testing locally, or your deployed URL once hosted (the confirm links
in the email are built from this value).

## Deploying (Render, free tier)

1. Push this repo to GitHub and create a new **Web Service** on Render
   pointing at it — `render.yaml` configures the build/start commands.
2. In the Render dashboard, set these environment variables (not committed):
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
   - `BASE_URL` → `https://<your-render-app>.onrender.com`

## Known limitations (accepted for this prototype, not bugs to fix)

- **Free-tier cold starts.** Render's free plan spins the service down when
  idle; the first request after a while can take 30–60s to respond.
- **Flat-file state doesn't survive a redeploy.** `state.json` lives on the
  instance's local disk, which Render's free tier does not persist across
  deploys/restarts.
- **Commitments themselves are shared, not per-visitor.** `state.json` is one
  file every visitor to the deployed URL reads and writes — anyone can mark
  anyone else's commitment done, or create new ones for any email. The
  identity cookie only decides what **My Tasks** filters to; it's not real
  access control.
- **First emails from a shared, unverified sender may land in spam.**
  `onboarding@resend.dev` (Resend's no-setup sender) has no sending history
  or domain reputation, which spam filters are cautious about by default —
  this is universal behavior for any brand-new sender, not specific to
  Resend or a bug here. Fixing it for real would mean verifying your own
  domain in Resend (sets up proper SPF/DKIM records), out of scope for a
  prototype. Check spam the first time a digest doesn't show up in inbox.

## Explicitly out of scope

Slack, mobile push, SMS, real Fireflies API access, production-grade auth,
persistence beyond the flat state file, notifying anyone other than the
commitment's own owner (the "not doing" flow only asks for a reason).
