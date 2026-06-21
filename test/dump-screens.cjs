// Capture rewritten SCREEN files (no disk write) for inspection.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const realWrite = fsp.writeFile.bind(fsp);
const cap = {};
fsp.writeFile = async (p, data, ...rest) => {
  if (typeof p === 'string' && (p.includes('/lib/screens/') || p.includes('/lib/components/'))) { cap[p] = data; return; }
  return realWrite(p, data, ...rest);
};
fsp.mkdir = async () => {};
const mod = require(path.join(__dirname, '..', 'dist', 'src', 'relay-server', 'passes', 'component-extraction.js'));
(async () => {
  const want = (process.argv[2] || '').split(',').filter(Boolean);
  await mod.extractComponents('Ping', { projectRoot: '/workspace/projects/Ping', dryRun: false, noAiConfirm: true });
  for (const [p, data] of Object.entries(cap)) {
    if (!p.includes('/lib/screens/')) continue;
    const base = path.basename(p);
    if (want.length && !want.some((w) => base.includes(w))) continue;
    console.log('\n##########', base, '##########');
    console.log(data);
  }
})().catch((e) => { console.error(e); process.exit(1); });
