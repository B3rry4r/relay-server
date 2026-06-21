// Dump generated component sources (dry) for inspection, without writing to the
// project. Monkeypatches fs.writeFile/mkdir so extractGroup "writes" go to stdout.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const realWrite = fsp.writeFile.bind(fsp);
const captured = {};
fsp.writeFile = async (p, data, ...rest) => {
  if (typeof p === 'string' && p.includes('/lib/components/')) {
    captured[p] = data;
    return; // swallow
  }
  return realWrite(p, data, ...rest);
};
// Swallow occurrence-file rewrites too (we only want component bodies here).
const realMkdir = fsp.mkdir.bind(fsp);
fsp.mkdir = async () => {};

const mod = require(path.join(__dirname, '..', 'dist', 'src', 'relay-server', 'passes', 'component-extraction.js'));

(async () => {
  // Force apply path (dryRun false) but writes are swallowed above.
  const want = (process.argv[2] || '').split(',').filter(Boolean);
  // Re-implement just enough: call extractComponents but intercept screen-file
  // writes by also swallowing any /lib/screens/ writes.
  const realWrite2 = fsp.writeFile;
  fsp.writeFile = async (p, data, ...rest) => {
    if (typeof p === 'string' && p.includes('/lib/screens/')) return; // swallow
    return realWrite2(p, data, ...rest);
  };
  await mod.extractComponents('Ping', {
    projectRoot: '/workspace/projects/Ping',
    dryRun: false,
    noAiConfirm: true,
  });
  for (const [p, data] of Object.entries(captured)) {
    const base = path.basename(p);
    if (want.length && !want.some((w) => base.includes(w))) continue;
    console.log('\n========================================', base, '========================================');
    console.log(data);
  }
})().catch((e) => { console.error(e); process.exit(1); });
