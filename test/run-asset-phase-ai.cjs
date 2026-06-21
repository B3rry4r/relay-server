// Real-AI runner for runAssetPhaseOnBuild against the live Ping app.
//
// Importing ai-routes.js binds the real runModel into ai-observability
// (setRunModel), so renameAssetsSemantic's requireModel makes REAL claude calls.
//
// Usage:
//   node test/run-asset-phase-ai.cjs                  # real-AI apply
//   node test/run-asset-phase-ai.cjs --dry            # dry-run (restores)
//   node test/run-asset-phase-ai.cjs --no-build       # skip flutter analyze/build gate
//   node test/run-asset-phase-ai.cjs --fail           # force AI unavailable (loud-fail proof)
const path = require('path');

// Bind the real runModel adapter (module-load side effect in ai-routes).
require(path.join(__dirname, '..', 'dist', 'src', 'relay-server', 'ai-routes.js'));
const obs = require(path.join(__dirname, '..', 'dist', 'src', 'relay-server', 'ai-observability.js'));
const { runAssetPhaseOnBuild } = require(path.join(__dirname, '..', 'dist', 'src', 'relay-server', 'passes', 'asset-phase.js'));

const projectRoot = '/workspace/projects/Ping';
const projectId = 'Ping';
const dryRun = process.argv.includes('--dry');
const skipBuildCheck = process.argv.includes('--no-build');
const forceFail = process.argv.includes('--fail');

// A runModel seam for the re-point pass (same adapter path).
const aiRoutes = require(path.join(__dirname, '..', 'dist', 'src', 'relay-server', 'ai-routes.js'));
const runModelSeam = forceFail
  ? async () => { throw new Error('forced: AI unavailable'); }
  : async (m, prompt, e, cwd, opts) => {
      const { text } = await aiRoutes.runModel(m, prompt, e, cwd, { format: opts && opts.format, projectId });
      return { text };
    };

(async () => {
  if (forceFail) {
    // Force the AI UNAVAILABLE: bind a throwing runner AFTER ai-routes' async
    // setRunModel(runModel) has settled (it binds on a resolved import promise),
    // so our override wins. requireModel must THROW → atomic rollback → reverted.
    await new Promise((r) => setTimeout(r, 200));
    obs.setRunModel(async () => { throw new Error('forced: AI unavailable (no runner)'); });
  }
  const report = await runAssetPhaseOnBuild(projectId, {
    projectRoot,
    model: 'claude',
    runModel: runModelSeam,
    env: process.env,
    dryRun,
    skipBuildCheck,
    log: (msg) => console.log(msg),
  });
  console.log('\n=== REPORT ===');
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
