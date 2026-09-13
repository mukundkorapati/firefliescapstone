// Populates state.json with a mix of commitments across every status, so the
// homepage has something to show without going through the full email loop
// first. Usage: node seed.js [your-email@example.com]
const fs = require('fs');

const you = process.argv[2] || 'you@example.com';
const teammate = 'teammate@example.com';
const priya = 'priya@example.com';
const now = Date.now();
const ago = (ms) => now - ms;

function commitment({ text, meeting, status, ownerEmail, createdAt, resolvedAt, reason }) {
  const history = [{ status: 'open', at: createdAt }];
  if (status !== 'open') history.push({ status, at: resolvedAt, ...(reason ? { reason } : {}) });
  return { text, meeting, status, ownerEmail, createdAt, updatedAt: resolvedAt || createdAt, ...(reason ? { reason } : {}), history };
}

const H = 3600000;
const state = {
  // Client Sync
  c_seed1: commitment({ text: 'Send the pricing sheet to the client', meeting: 'Client Sync', status: 'open', ownerEmail: you, createdAt: ago(6 * H) }),
  c_seed2: commitment({ text: 'Follow up with legal on the MSA redlines', meeting: 'Client Sync', status: 'done', ownerEmail: you, createdAt: ago(30 * H), resolvedAt: ago(4 * H) }),
  c_seed3: commitment({ text: 'Book the vendor demo for next sprint', meeting: 'Client Sync', status: 'open', ownerEmail: teammate, createdAt: ago(50 * H) }),
  c_seed4: commitment({ text: 'Draft the onboarding checklist', meeting: 'Client Sync', status: 'not_doing', reason: 'no_longer_needed', ownerEmail: teammate, createdAt: ago(70 * H), resolvedAt: ago(20 * H) }),
  c_seed5: commitment({ text: 'Loop in finance on the renewal terms', meeting: 'Client Sync', status: 'done', ownerEmail: you, createdAt: ago(90 * H), resolvedAt: ago(60 * H) }),

  // Product Roadmap Review
  c_seed6: commitment({ text: 'Share the updated roadmap deck', meeting: 'Product Roadmap Review', status: 'open', ownerEmail: you, createdAt: ago(2 * H) }),
  c_seed7: commitment({ text: 'Confirm Q3 OKRs with leadership', meeting: 'Product Roadmap Review', status: 'open', ownerEmail: teammate, createdAt: ago(10 * H) }),
  c_seed8: commitment({ text: 'Circulate the roadmap doc for async comments', meeting: 'Product Roadmap Review', status: 'open', ownerEmail: you, createdAt: ago(28 * H) }),
  c_seed9: commitment({ text: 'Get design sign-off on the new nav', meeting: 'Product Roadmap Review', status: 'not_doing', reason: 'blocked', ownerEmail: priya, createdAt: ago(48 * H), resolvedAt: ago(12 * H) }),

  // Weekly Standup
  c_seed10: commitment({ text: 'Post the sprint burndown in #eng', meeting: 'Weekly Standup', status: 'done', ownerEmail: teammate, createdAt: ago(15 * H), resolvedAt: ago(8 * H) }),
  c_seed11: commitment({ text: 'Triage the new bug backlog', meeting: 'Weekly Standup', status: 'open', ownerEmail: priya, createdAt: ago(5 * H) }),
  c_seed12: commitment({ text: 'Pair with Priya on the flaky test suite', meeting: 'Weekly Standup', status: 'open', ownerEmail: you, createdAt: ago(20 * H) }),

  // Design Review
  c_seed13: commitment({ text: 'Update the component library changelog', meeting: 'Design Review', status: 'open', ownerEmail: priya, createdAt: ago(1 * H) }),
  c_seed14: commitment({ text: 'Send Figma access to the new contractor', meeting: 'Design Review', status: 'not_doing', reason: 'deprioritized', ownerEmail: you, createdAt: ago(40 * H), resolvedAt: ago(35 * H) }),
};

fs.writeFileSync('./state.json', JSON.stringify(state, null, 2));
const openForYou = Object.values(state).filter(c => c.ownerEmail === you && c.status === 'open').length;
console.log(`Seeded state.json with ${Object.keys(state).length} commitments — ${openForYou} open and assigned to ${you}.`);
