// Ad-hoc runner for runAssetPhaseOnBuild against the real Ping app.
// Usage: node test/run-asset-phase.cjs [--dry] [--skip-build-check]
const path = require('path');
const { runAssetPhaseOnBuild } = require(path.join(__dirname, '..', 'dist', 'src', 'relay-server', 'passes', 'asset-phase.js'));

const projectRoot = '/workspace/projects/Ping';
const projectId = 'Ping';
const dryRun = process.argv.includes('--dry');
const skipBuildCheck = process.argv.includes('--skip-build-check');

(async () => {
  const report = await runAssetPhaseOnBuild(projectId, {
    projectRoot,
    // No model → deterministic hint-based rename (offline; AI key absent in this shell).
    model: undefined,
    runModel: undefined,
    env: process.env,
    dryRun,
    skipBuildCheck,
    log: (m) => console.log(m),
  });
  console.log('\n=== REPORT ===');
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
