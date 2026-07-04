// =============================================================================
// P1-core — per-state / per-modal PREVIEW ENTRIES (design-system.ts).
//
// The verify loop's preview entry hardcoded the default constructor, so no path
// ever rendered `Screen(state: 'x')` and no modal was ever presented — the
// prompt's "each state is verified individually" was false. These tests prove:
//   • default entry unchanged (legacy screen_<frameId>.dart resolution);
//   • state variant renders `<Screen>(state: '<id>')`;
//   • modal variant renders the base + AUTO-PRESENTS via the deterministic
//     presenter (modalPresenterName) after the first frame;
//   • semantic-named screen files resolve via the `// canonicalId:` header.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ensureScreenPreviewEntry, modalPresenterName } from '../src/relay-server/design-system';

let root: string;

const LEGACY_SCREEN = `
import 'package:flutter/material.dart';
class UserRegistrationScreen extends StatelessWidget {
  const UserRegistrationScreen({super.key, this.state = 'default'});
  final String state;
  @override
  Widget build(BuildContext context) => const Scaffold();
}
`;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-variant-'));
  await fs.mkdir(path.join(root, 'lib', 'screens'), { recursive: true });
});
afterEach(async () => { try { await fs.rm(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');

describe('modalPresenterName', () => {
  it('derives the deterministic presenter from the modal id', () => {
    expect(modalPresenterName('m_313_9543')).toBe('showModal_313_9543');
    expect(modalPresenterName('m_300:3600')).toBe('showModal_300_3600');
  });
});

describe('ensureScreenPreviewEntry variants', () => {
  it('default entry (no variant) is unchanged: bare constructor home', async () => {
    await fs.writeFile(path.join(root, 'lib', 'screens', 'screen_286_3158.dart'), LEGACY_SCREEN);
    const entry = await ensureScreenPreviewEntry(root, 'flutter', '286:3158');
    expect(entry).toBe('lib/_preview/screen_286_3158_preview.dart');
    const code = await read(entry!);
    expect(code).toContain('home: UserRegistrationScreen(),');
    expect(code).not.toContain('state:');
  });

  it('state variant renders Screen(state: <id>)', async () => {
    await fs.writeFile(path.join(root, 'lib', 'screens', 'screen_286_3158.dart'), LEGACY_SCREEN);
    const entry = await ensureScreenPreviewEntry(root, 'flutter', '286:3158', { variant: { kind: 'state', id: 'success' } });
    expect(entry).toBe('lib/_preview/screen_286_3158_state_success_preview.dart');
    const code = await read(entry!);
    expect(code).toContain(`home: UserRegistrationScreen(state: 'success'),`);
  });

  it('modal variant renders the base and auto-presents via the contract presenter', async () => {
    await fs.writeFile(path.join(root, 'lib', 'screens', 'screen_286_3158.dart'), LEGACY_SCREEN);
    const entry = await ensureScreenPreviewEntry(root, 'flutter', '286:3158', { variant: { kind: 'modal', id: 'm_313_9543' } });
    expect(entry).toBe('lib/_preview/screen_286_3158_modal_313_9543_preview.dart');
    const code = await read(entry!);
    // Base screen is the host's body…
    expect(code).toContain('Widget build(BuildContext context) => UserRegistrationScreen()');
    // …and the modal is presented after the first frame by the FIXED-name presenter
    // (the build contract requires the screen file to export exactly this symbol).
    expect(code).toContain('WidgetsBinding.instance.addPostFrameCallback');
    expect(code).toContain('showModal_313_9543(context);');
  });

  it('resolves SEMANTIC-named screen files via the canonicalId header', async () => {
    await fs.writeFile(
      path.join(root, 'lib', 'screens', 'user_registration_screen.dart'),
      `// canonicalId: c_286_3158  route: /user-registration\n${LEGACY_SCREEN}`,
    );
    // No screen_286_3158.dart on disk → legacy resolution alone would return undefined.
    expect(await ensureScreenPreviewEntry(root, 'flutter', '286:3158')).toBeUndefined();
    const entry = await ensureScreenPreviewEntry(root, 'flutter', '286:3158', {
      canonicalId: 'c_286_3158', variant: { kind: 'modal', id: 'm_313_9647' },
    });
    expect(entry).toBe('lib/_preview/user_registration_screen_modal_313_9647_preview.dart');
    const code = await read(entry!);
    expect(code).toContain(`import '../screens/user_registration_screen.dart';`);
    expect(code).toContain('showModal_313_9647(context);');
  });

  it('returns undefined for non-flutter frameworks and missing screen files', async () => {
    expect(await ensureScreenPreviewEntry(root, 'react', '1:1', { variant: { kind: 'state', id: 'x' } })).toBeUndefined();
    expect(await ensureScreenPreviewEntry(root, 'flutter', '9:9', { variant: { kind: 'state', id: 'x' } })).toBeUndefined();
  });
});
