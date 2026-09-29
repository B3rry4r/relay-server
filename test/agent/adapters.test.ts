// Golden adapter tests (agent-display-spec §12.1): every fixture under
// test/fixtures/agent/<cli>/*.jsonl (written by the REAL CLIs against a mock
// model, or by the fake agent) is run through the ported adapter and must
// deep-equal the golden *.normalized.json produced by the research prototype.
// Regenerate goldens only with a reviewed diff.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeLine } from '../../src/relay-server/agent/adapters/claude';
import { codexLine } from '../../src/relay-server/agent/adapters/codex';
import { geminiMessage, geminiReduce } from '../../src/relay-server/agent/adapters/gemini';
import { spoolRecord } from '../../src/relay-server/agent/adapters/spool';
import { LineSplitter } from '../../src/relay-server/agent/tail';

const FX = path.resolve(__dirname, '../fixtures/agent');
const readJsonl = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

type Job = { cli: string; file: string };
const jobs: Job[] = [];
for (const cli of ['claude', 'codex', 'gemini', 'opencode']) {
  for (const name of fs.readdirSync(path.join(FX, cli)).filter((n) => n.endsWith('.jsonl'))) jobs.push({ cli, file: path.join(FX, cli, name) });
}

function adapt(cli: string, file: string, lines: any[]): unknown[] {
  if (/spool/.test(file)) return lines.flatMap(spoolRecord);
  if (cli === 'claude') return lines.flatMap(claudeLine);
  if (cli === 'codex') return lines.flatMap(codexLine);
  if (cli === 'gemini') return geminiReduce(lines).messages.flatMap(geminiMessage);
  throw new Error(`no adapter for ${file}`);
}

/** JSON round-trip drops undefined keys exactly like the prototype's writer did. */
const asWritten = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('agent adapters reproduce the golden fixtures', () => {
  it('found all 14 fixture transcripts/spools', () => {
    expect(jobs.length).toBe(14);
  });

  for (const { cli, file } of jobs) {
    it(`${cli}: ${path.basename(file)}`, () => {
      const golden = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.normalized.json'), 'utf8'));
      const out = asWritten(adapt(cli, file, readJsonl(file)));
      expect(out.length).toBeGreaterThan(0);
      expect(out).toEqual(golden);
    });

    it(`${cli}: ${path.basename(file)} — byte-chunked through the tailer's line splitter gives the same events`, () => {
      const bytes = fs.readFileSync(file);
      // deterministic pseudo-random 1..200-byte chunks (seeded by file size)
      let seed = bytes.length;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
      const splitter = new LineSplitter();
      const lines: Array<{ line: string; offset: number }> = [];
      for (let i = 0; i < bytes.length;) {
        const n = 1 + (rnd() % 200);
        lines.push(...splitter.push(bytes.subarray(i, i + n)));
        i += n;
      }
      lines.push(...splitter.end());
      const parsed = lines.map((l) => JSON.parse(l.line));
      expect(asWritten(adapt(cli, file, parsed))).toEqual(asWritten(adapt(cli, file, readJsonl(file))));
      // offsets are byte positions of each line start in the file
      for (const l of lines) expect(bytes.subarray(l.offset, l.offset + Buffer.byteLength(l.line)).toString('utf8')).toBe(l.line);
    });
  }
});
