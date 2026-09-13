// Manually re-populates state.json with the default demo dataset — useful
// for resetting during testing. The server also auto-seeds this same
// dataset on first boot if state.json doesn't exist yet (see server.js),
// so a fresh deploy is never empty. Usage: node seed.js
const fs = require('fs');
const { buildSeedState } = require('./seedData');

const state = buildSeedState();
fs.writeFileSync('./state.json', JSON.stringify(state, null, 2));
console.log(`Seeded state.json with ${Object.keys(state).length} commitments across mukundkorapati@gmail.com, teammate@example.com, and priya@example.com.`);
