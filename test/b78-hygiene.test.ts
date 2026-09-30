// =============================================================================
// B78 readability — the deterministic provenance strip (F6) and stub-component
// removal (F1) behind 7h productionHygiene. The parity harness grades the pass end
// to end on all three fixtures; these pin the strip's rules on real Ping comments.
// =============================================================================
import { describe, it, expect } from 'vitest';
import { stripProvenance, stripProvenanceLines, stripProvenanceText, isStubComponent, hasProvenance } from '../src/relay-server/passes/source-hygiene';

describe('F6 provenance strip — real Ping comments', () => {
  const cases: Array<[string, string]> = [
    ['Back chevron (IR "Icons" 24×24 slot), above the accent line.', 'Back chevron, above the accent line.'],
    ['Centred row of passcode dots (IR "Ellipse 2797–2800", 27×27 each).', 'Centred row of passcode dots.'],
    ['Pure success green — uploaded-file confirmation text (added by /identity-verification).', 'Pure success green — uploaded-file confirmation text.'],
    ['── Home dashboard (frame 64, added by /home-dashboard) ──', '── Home dashboard ──'],
    ['"Manual Entry" → /bank-transfer-details   (push, frame 92)', '"Manual Entry" → /bank-transfer-details'],
    ['"scan QR" → /select-bank (the scan-a-bank flow, frame 45)', '"scan QR" → /select-bank (the scan-a-bank flow)'],
    ['Frame 83 shows the "Or / fingerprint" biometric shortcut; frame 84 omits it.', ''],
    ['static display fields. The IR "Confirm" angle-left/right chevrons are omitted', 'static display fields. The angle-left/right chevrons are omitted'],
    ['Verification loading state (modal m_313_10287 / frame 81) — a non-dismissible', 'Verification loading state — a non-dismissible'],
    ['Soft-filled, read-only value field (matches the reference\'s prefilled state).', 'Soft-filled, read-only value field.'],
    ['7×7 finder pattern squares at three corners.', 'finder pattern squares at three corners.'],
  ];
  for (const [input, want] of cases) {
    it(JSON.stringify(input).slice(0, 70), () => { expect(stripProvenanceText(input)).toBe(want); });
  }

  it('a parenthetical that wraps onto the next comment line goes whole, the line break stays', () => {
    expect(stripProvenanceLines([
      'Canonical screen — cardOtpVerificationScreen (canonicalId c_290_4046,',
      'route /card-otp-verification). Card verification OTP step.',
    ])).toEqual(['Canonical screen — cardOtpVerificationScreen (route /card-otp-verification)', 'Card verification OTP step.']);
  });

  it('never edits a pipeline marker line, a string literal, or code', () => {
    const dart = "// canonicalId: c_290_4046  route: /card-otp-verification\n// GENERATED SKELETON — frame 61\nconst label = 'frame 61 (IR \"Rectangle 24\")'; // Back chevron (IR \"Icons\" 24×24 slot).\nfinal x = 1; /* frame 12 */\n";
    const r = stripProvenance(dart, 'dart');
    expect(r.src).toBe("// canonicalId: c_290_4046  route: /card-otp-verification\n// GENERATED SKELETON — frame 61\nconst label = 'frame 61 (IR \"Rectangle 24\")'; // Back chevron.\nfinal x = 1;\n");
    const tsx = "// canonicalId: c_10_1 route: /login\n'use client';\nconst url = `/x/${'frame 12'}`; // frame 12\n/**\n * Login card (IR \"Rectangle 24\").\n * Frame 61 shows it.\n */\nexport function A() { return <div title=\"frame 61\" />; }\n";
    expect(stripProvenance(tsx, 'ts').src).toBe("// canonicalId: c_10_1 route: /login\n'use client';\nconst url = `/x/${'frame 12'}`;\n/**\n * Login card.\n */\nexport function A() { return <div title=\"frame 61\" />; }\n");
  });

  it('is idempotent and leaves provenance-free text byte-identical', () => {
    const src = '// Login form — submits the credentials.\n// Dots row (IR "Ellipse 1").\n';
    const once = stripProvenance(src, 'dart').src;
    expect(stripProvenance(once, 'dart').src).toBe(once);
    expect(hasProvenance(once)).toBe(false);
    const clean = '// A 2x speed toggle (see settings).\n';
    expect(stripProvenance(clean, 'dart').src).toBe(clean);
  });
});

describe('F1 stub-component detection', () => {
  it('dart: the skeleton stub, not a real widget or a State class', () => {
    expect(isStubComponent("// GENERATED SKELETON\nclass OtherWidget extends StatelessWidget {\n  const OtherWidget({super.key});\n  @override\n  Widget build(BuildContext context) => const SizedBox.shrink();\n}\n", 'dart')).toBe(true);
    expect(isStubComponent("class Card extends StatelessWidget {\n  @override\n  Widget build(BuildContext context) => Container();\n}\n", 'dart')).toBe(false);
    expect(isStubComponent("class A extends StatefulWidget {}\nclass _AState extends State<A> {\n  @override\n  Widget build(BuildContext context) { return const SizedBox.shrink(); }\n}\n", 'dart')).toBe(false);
  });
  it('web: a GENERATED SKELETON component stub only', () => {
    expect(isStubComponent('// GENERATED SKELETON — shared component stub\nexport function Other() {\n  return null;\n}\n', 'ts')).toBe(true);
    expect(isStubComponent('export function Other() {\n  return null;\n}\n', 'ts')).toBe(false);
  });
});
