#!/usr/bin/env node
// CLI for the readability metric. The implementation is
// src/relay-server/readability-report.cjs — kept under src/ so the compiled server
// (dist/src, the only code a release ships) carries it; see that file for usage.
const tool = require('../src/relay-server/readability-report.cjs');

module.exports = tool;
if (require.main === module) tool.main(process.argv.slice(2));
