// Ad-hoc runner for the Phase 7c asset-usage re-point pass against a fixture.
// Usage: node test/run-repoint.cjs <projectRoot> [--apply] [--ai]
const path = require('path');
const mod = require(path.join(__dirname, '..', 'dist', 'src', 'relay-server', 'passes', 'asset-usage.js'));

(async () => {
  const projectRoot = process.argv[2] || '/workspace/projects/asset-usage-fixture';
  const apply = process.argv.includes('--apply');
  const useAi = process.argv.includes('--ai');

  // Deterministic stub model for the hard semantic icon match (no live CLI here).
  // Mirrors what a real model would answer: qr_code_scanner -> the qr_scan asset.
  const stubRunModel = async (_m, prompt) => {
    // The prompt lists candidate icon assets `  <i>: name "<name>" ...`.
    // Pick the index of the asset whose name best matches the icon mentioned.
    const iconM = /Icons\.([a-z_]+)/.exec(prompt);
    const icon = iconM ? iconM[1] : '';
    const cands = [...prompt.matchAll(/^\s*(\d+): name "([^"]+)"/gm)].map((x) => ({ i: Number(x[1]), name: x[2] }));
    let pick = null;
    if (/scan/.test(icon)) pick = cands.find((c) => /scan/.test(c.name));
    if (pick) return { text: JSON.stringify({ index: pick.i }) };
    return { text: JSON.stringify({ index: null }) };
  };

  const res = await mod.repointAssetUsage('fixture', {
    projectRoot,
    dryRun: !apply,
    noAi: !useAi,
    model: useAi ? 'claude' : undefined,
    runModel: useAi ? stubRunModel : undefined,
    env: process.env,
  });
  console.log(JSON.stringify(res, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
