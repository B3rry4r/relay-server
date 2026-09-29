/*
 * ScreenGuard (agent-display-spec §8.2/§8.3): a headless xterm per terminal,
 * fed from the PTY output ONLY while an agent session is attached. It answers
 * one question before any key is written: "is the CLI's permission prompt on
 * screen right now?" — and, for hook-less sessions, detects prompts itself.
 */
import { Terminal } from '@xterm/headless';
import type { AgentCli } from './types';

export interface ScreenSignature {
  /** Every pattern must match the visible screen. */
  permission: RegExp[];
  /** Edit / patch prompts — UNVERIFIED (§8.1): never answerable from a card, only detected. */
  edit?: RegExp[];
  /** The CLI's own "interrupt" hint, shown while a turn runs (UNVERIFIED as an Esc-interrupt, §7.2). */
  interruptHint: RegExp;
}

/** §8.1 signature table (verified against the real TUIs; see test/fixtures/agent/<cli>/*.screen-*.txt). */
export const SCREEN_SIGNATURES: Readonly<Record<AgentCli, ScreenSignature>> = Object.freeze({
  claude: { permission: [/Do you want to proceed\?/, /❯\s*1\. Yes/], edit: [/Do you want to make this edit/], interruptHint: /esc to interrupt/i },
  codex: { permission: [/Would you like to run the following command\?/], edit: [/Would you like to make the following edits\?/], interruptHint: /esc to interrupt/i },
  gemini: { permission: [/Allow execution of \[/], edit: [/Apply this change\?/], interruptHint: /esc to cancel/i },
  opencode: { permission: [/Permission required/], interruptHint: /esc (to )?interrupt/i },
});

/** Codex's one-time hook-trust dialog (§10.4). */
export const CODEX_HOOK_REVIEW = /Hooks need review/;

export function matchesPermission(cli: AgentCli, screen: string): boolean {
  return SCREEN_SIGNATURES[cli].permission.every((re) => re.test(screen));
}

/** The command line shown under a permission signature (title for screen-sourced requests). */
export function commandUnderSignature(cli: AgentCli, screen: string): string {
  const lines = screen.split('\n').map((l) => l.replace(/[│┃╭╮╰╯]/g, ' ').trim());
  const dollar = lines.find((l) => /^\$\s+\S/.test(l));
  if (dollar) return dollar.replace(/^\$\s+/, '').slice(0, 160);
  if (cli === 'claude') {
    const i = lines.findIndex((l) => /^Bash command$/.test(l));
    if (i !== -1) {
      const cmd = lines.slice(i + 1).find((l) => l && !/^Tip:/.test(l));
      if (cmd) return cmd.slice(0, 160);
    }
  }
  if (cli === 'gemini') {
    const head = lines.find((l) => /^\?\s+\S+\s+\S/.test(l));
    if (head) return head.replace(/^\?\s+\S+\s+/, '').slice(0, 160);
  }
  return 'Permission requested in the terminal';
}

export interface ScreenGuardOptions {
  cols?: number;
  rows?: number;
  /** Debounce for onChange (§8.2: 150 ms). */
  debounceMs?: number;
  onChange?: (screen: string) => void;
}

export class ScreenGuard {
  private term: Terminal;
  private changeTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private opts: ScreenGuardOptions;

  constructor(opts: ScreenGuardOptions = {}) {
    this.opts = opts;
    this.term = new Terminal({
      cols: clampDim(opts.cols, 100),
      rows: clampDim(opts.rows, 34),
      allowProposedApi: true,
      scrollback: 200,
    });
  }

  get cols(): number { return this.term.cols; }
  get rows(): number { return this.term.rows; }

  /** DECCKM — arrows must be sent as ESC O x when the app enabled it. */
  get applicationCursorKeys(): boolean {
    return Boolean(this.term.modes?.applicationCursorKeysMode);
  }

  write(data: string): void {
    if (this.disposed || !data) return;
    this.term.write(data, () => this.scheduleChange());
  }

  /** Drop everything (e.g. before seeding from a scrollback replay). */
  reset(): void {
    if (this.disposed) return;
    this.term.reset();
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const c = clampDim(cols, this.term.cols);
    const r = clampDim(rows, this.term.rows);
    if (c !== this.term.cols || r !== this.term.rows) this.term.resize(c, r);
  }

  /** Resolves once every byte written so far has been parsed. */
  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => this.term.write('', () => resolve()));
  }

  /** The visible viewport as text (trailing blanks trimmed per line). */
  text(): string {
    if (this.disposed) return '';
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i += 1) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
    return lines.join('\n');
  }

  async screen(): Promise<string> {
    await this.flush();
    return this.text();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.term.dispose();
  }

  private scheduleChange(): void {
    if (!this.opts.onChange || this.changeTimer || this.disposed) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      if (!this.disposed) this.opts.onChange?.(this.text());
    }, this.opts.debounceMs ?? 150);
    this.changeTimer.unref?.();
  }
}

function clampDim(value: number | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 2) return fallback;
  return Math.min(n, 1000);
}
