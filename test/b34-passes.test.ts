/**
 * Lane B34 regression tests: passes 7a, 7b, 7d, 7e, 7f, 7g, 7h on flutter, react
 * and next. The parity ratchet (test/parity) grades the fixtures end to end; these
 * pin the individual mechanisms each fix relies on.
 */
import { describe, it, expect } from 'vitest';
import { __test as audit } from '../src/relay-server/passes/interaction-audit';

describe('7g labels name the control that owns the dead handler (PG-22, PG-23)', () => {
  it('jsx: the button text, not a neighbouring <Badge label=…>', () => {
    const src = `<section>\n  <Badge label="beta" />\n  <SearchGlyph />\n  <button onClick={() => {}}>Resolve</button>\n  <PillButton label="Save" />\n</section>`;
    expect(audit.jsxOwnerLabel(src, src.indexOf('onClick'))).toBe('Resolve');
  });
  it('jsx: own aria-label wins; nested text/expressions are flattened', () => {
    const a = `<button aria-label="Close" onClick={() => {}}><Icon /></button>`;
    expect(audit.jsxOwnerLabel(a, a.indexOf('onClick'))).toBe('Close');
    const b = `<button className={cx('a', {b: true})} onClick={() => {}}>\n  <Icon/> Resolve {count} dispute\n</button>`;
    expect(audit.jsxOwnerLabel(b, b.indexOf('onClick'))).toBe('Resolve dispute');
    const c = `<IconButton onClick={() => {}} />\n<Badge label="new" />`;
    expect(audit.jsxOwnerLabel(c, c.indexOf('onClick'))).toBeNull();
  });
  it('dart: the widget\'s own child Text / tooltip, never a sibling', () => {
    const src = `Column(children: [\n  const _SectionHeading(title: 'Settings'),\n  TextButton(onPressed: () {}, child: const Text('Resolve')),\n  const _PillButton(label: 'Save'),\n])`;
    expect(audit.dartOwnerLabel(src, src.indexOf('onPressed'))).toBe('Resolve');
    const icon = `IconButton(\n  icon: const Icon(Icons.close),\n  tooltip: 'Close',\n  onPressed: () {},\n)`;
    expect(audit.dartOwnerLabel(icon, icon.indexOf('onPressed'))).toBe('Close');
    const bare = `GestureDetector(onTap: () {}, child: const Icon(Icons.add)), Text('Other')`;
    expect(audit.dartOwnerLabel(bare, bare.indexOf('onTap'))).toBeNull();
  });
});
