require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const { WebClient } = require('@slack/web-api');

const app = express();
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const INSTALLS_FILE = './installs.json';
const COMMITMENTS_FILE = './commitments.json';
function load(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; }
function save(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

const SCOPES = ['chat:write', 'im:write', 'users:read.email'].join(',');

// ================= INSTALL FLOW =================

app.get('/slack/install', (req, res) => {
  const tier = req.query.tier || 'free';
  const url = `https://slack.com/oauth/v2/authorize` +
    `?client_id=${process.env.SLACK_CLIENT_ID}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
    `&state=${tier}`;
  res.redirect(url);
});

app.get('/slack/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/slack/install/help?tier=${state || 'free'}`);

  const resp = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: process.env.REDIRECT_URI,
    }),
  });
  const data = await resp.json();
  if (!data.ok) return res.redirect(`/slack/install/help?tier=${state || 'free'}`);

  const installs = load(INSTALLS_FILE);
  installs[data.team.id] = {
    team_name: data.team.name,
    bot_token: data.access_token,
    tier: state || 'free',
  };
  save(INSTALLS_FILE, installs);

  // hand back a team_id so the next step (sending a test commitment) can use it
  res.send(`
    <h2>Connected to ${data.team.name}</h2>
    <p>team_id: <code>${data.team.id}</code> — you'll need this for the trigger step below.</p>
    <form method="POST" action="/trigger">
      <input type="hidden" name="team_id" value="${data.team.id}" />
      <p><input name="owner_email" placeholder="your email in this workspace" style="width:250px" /></p>
      <p><input name="text" placeholder="commitment text" value="Send the pricing sheet" style="width:250px" /></p>
      <p><input name="meeting" placeholder="meeting name" value="Client Sync" style="width:250px" /></p>
      <button type="submit">Send test commitment card</button>
    </form>
  `);
});

app.get('/slack/install/help', (req, res) => {
  const { tier } = req.query;
  const note = tier === 'enterprise'
    ? 'Larger workspaces often have this on by default.'
    : 'Less common on your plan, but some teams enable it deliberately.';
  res.send(`<h2>Your workspace needs admin approval</h2><p>${note}</p>
    <p>Ask your Workspace Owner to approve Fireflies from Slack's Apps page, then try again.</p>`);
});

// ================= COMMITMENT CARD =================

function buildBlocks(c) {
  if (c.status !== 'open') {
    const labels = { done: '✅ Marked done', not_doing: '🚫 Marked not doing', blocked: '📅 Time blocked', not_mine: '↩️ Returned' };
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `~${c.text}~\n_${c.meeting}_` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `*${labels[c.status]}* — ${new Date().toLocaleTimeString()}` }] },
    ];
  }
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `You committed to this in *${c.meeting}*:\n*"${c.text}"*` } },
    {
      type: 'actions',
      block_id: `commitment_${c.id}`,
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Done' }, action_id: 'done', value: c.id },
        { type: 'button', text: { type: 'plain_text', text: 'Not doing' }, action_id: 'not_doing', value: c.id },
        { type: 'button', text: { type: 'plain_text', text: 'Block time' }, action_id: 'blocked', value: c.id },
        { type: 'button', text: { type: 'plain_text', text: 'Not mine' }, action_id: 'not_mine', value: c.id },
      ],
    },
  ];
}

// POST /trigger : uses the STORED token for team_id — not a hardcoded one
app.post('/trigger', async (req, res) => {
  const { team_id, owner_email, text, meeting } = req.body;
  const installs = load(INSTALLS_FILE);
  const install = installs[team_id];
  if (!install) return res.status(404).send('No install found for that team_id — run /slack/install first.');

  const slack = new WebClient(install.bot_token);
  try {
    const lookup = await slack.users.lookupByEmail({ email: owner_email });
    const dm = await slack.conversations.open({ users: lookup.user.id });

    const id = 'c_' + Date.now();
    const commitment = { id, team_id, text, meeting, status: 'open', channel: dm.channel.id };
    const posted = await slack.chat.postMessage({ channel: dm.channel.id, text, blocks: buildBlocks(commitment) });
    commitment.ts = posted.ts;

    const commitments = load(COMMITMENTS_FILE);
    commitments[id] = commitment;
    save(COMMITMENTS_FILE, commitments);

    res.send(`<p>Sent. Check your Slack DMs.</p><p><a href="/slack/oauth/callback?code=&state=${install.tier}">Send another</a></p>`);
  } catch (err) {
    res.status(500).send(`Error: ${err.message} — check the email matches a real member of this workspace.`);
  }
});

// POST /slack/interactions : button clicks
app.post('/slack/interactions', async (req, res) => {
  res.status(200).send();
  const payload = JSON.parse(req.body.payload);
  const action = payload.actions[0];
  const id = action.value;

  const commitments = load(COMMITMENTS_FILE);
  const c = commitments[id];
  if (!c) return console.error('Unknown commitment', id);
  if (c.status !== 'open') return console.log('Already resolved, ignoring click');

  c.status = action.action_id;
  save(COMMITMENTS_FILE, commitments);

  const installs = load(INSTALLS_FILE);
  const slack = new WebClient(installs[c.team_id].bot_token);
  await slack.chat.update({ channel: c.channel, ts: c.ts, text: c.text, blocks: buildBlocks(c) });
});

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
