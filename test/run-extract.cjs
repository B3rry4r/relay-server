// Ad-hoc runner for the Phase 7a component-extraction pass against Ping.
// Usage: node test/run-extract.cjs [--apply]
const path = require('path');
const mod = require(path.join(__dirname, '..', 'dist', 'src', 'relay-server', 'passes', 'component-extraction.js'));

(async () => {
  const apply = process.argv.includes('--apply');
  const projectRoot = '/workspace/projects/Ping';
  const res = await mod.extractComponents('Ping', {
    projectRoot,
    dryRun: !apply,
    noAiConfirm: true, // deterministic structural match for the test run
  });
  console.log(JSON.stringify(res, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
