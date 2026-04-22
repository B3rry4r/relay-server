import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io as createClient, type Socket } from 'socket.io-client';
import { createRelayServer, FakePty, type PtyFactory, type RelayServer } from '../src/relay-server';

const execFile = promisify(execFileCallback);

async function connectClient(port: number, token = 'test-token'): Promise<Socket> {
  const client = createClient(`http://127.0.0.1:${port}`, {
    auth: {
      token,
    },
    reconnection: false,
    transports: ['websocket'],
  });

  await new Promise<void>((resolve, reject) => {
    client.on('connect', () => resolve());
    client.on('connect_error', reject);
  });

  return client;
}

describe('Relay server', () => {
  const servers: RelayServer[] = [];
  const clients: Socket[] = [];
  const tempDirectories: string[] = [];

  async function createWorkspaceFixture(): Promise<string> {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-workspace-'));
    tempDirectories.push(workspace);
    await fs.mkdir(path.join(workspace, 'projects'), { recursive: true });
    return workspace;
  }

  async function initGitRepo(projectRoot: string): Promise<void> {
    await execFile('git', ['init'], { cwd: projectRoot });
    await execFile('git', ['config', 'user.email', 'relay@example.com'], { cwd: projectRoot });
    await execFile('git', ['config', 'user.name', 'Relay Test'], { cwd: projectRoot });
  }

  afterEach(async () => {
    while (clients.length > 0) {
      const client = clients.pop();
      client?.disconnect();
    }

    while (servers.length > 0) {
      const server = servers.pop();
      await server?.stop();
    }

    delete process.env.PORT;
    delete process.env.WORKSPACE;
    delete process.env.SHELL;
    delete process.env.AUTH_TOKEN;
    delete process.env.VSCODE_GIT_IPC_HANDLE;
    delete process.env.TERM_PROGRAM;
    delete process.env.TERM_PROGRAM_VERSION;
    delete process.env.PROMPT_COMMAND;

    while (tempDirectories.length > 0) {
      const directory = tempDirectories.pop();
      await fs.rm(directory!, { recursive: true, force: true });
    }
  });

  it('serves backend metadata at the root route', async () => {
    process.env.PORT = '0';

    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();

    const response = await request(`http://127.0.0.1:${port}`).get('/');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      name: 'Relay',
      service: 'terminal-backend',
      status: 'ok',
      transport: {
        httpAuthHeader: 'x-auth-token',
        socketAuthField: 'auth.token',
        socketPath: '/socket.io',
      },
    });
  });

  it('rejects auth validation when the token is missing or invalid', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';

    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();

    const missingTokenResponse = await request(`http://127.0.0.1:${port}`).get('/api/auth/validate');
    const invalidTokenResponse = await request(`http://127.0.0.1:${port}`)
      .get('/api/auth/validate')
      .query({ token: 'wrong-token' });

    expect(missingTokenResponse.status).toBe(401);
    expect(missingTokenResponse.body.error).toBe('unauthorized');
    expect(invalidTokenResponse.status).toBe(401);
    expect(invalidTokenResponse.body.error).toBe('unauthorized');
  });

  it('accepts the auth token from the x-auth-token header', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';

    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();

    const response = await request(`http://127.0.0.1:${port}`)
      .get('/api/auth/validate')
      .set('x-auth-token', 'test-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authenticated: true });
  });

  it('accepts the auth token from the bearer authorization header', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';

    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();

    const response = await request(`http://127.0.0.1:${port}`)
      .get('/api/auth/validate')
      .set('authorization', 'Bearer test-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authenticated: true });
  });

  it('returns bootstrap status from the workspace', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.WORKSPACE = await createWorkspaceFixture();

    await fs.writeFile(path.join(process.env.WORKSPACE, '.bootstrap-status'), 'bootstrap=partial\nnvm=installed\n');
    await fs.writeFile(path.join(process.env.WORKSPACE, '.bootstrapped'), '');

    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();

    const response = await request(`http://127.0.0.1:${port}`)
      .get('/api/bootstrap/status')
      .set('x-auth-token', 'test-token');

    expect(response.status).toBe(200);
    expect(response.body.workspace).toBe(process.env.WORKSPACE);
    expect(response.body.bootstrapped).toBe(true);
    expect(response.body.status).toEqual({
      bootstrap: 'partial',
      nvm: 'installed',
    });
  });

  it('supports project and file management APIs', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.WORKSPACE = await createWorkspaceFixture();

    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();
    const base = request(`http://127.0.0.1:${port}`);

    const createProject = await base
      .post('/api/projects')
      .set('x-auth-token', 'test-token')
      .send({
        name: 'my-app',
        template: 'blank',
        initializeGit: true,
      });

    expect(createProject.status).toBe(201);
    expect(createProject.body.project.path).toBe(path.join(process.env.WORKSPACE, 'projects', 'my-app'));
    expect(createProject.body.project.gitInitialized).toBe(true);

    const listProjects = await base
      .get('/api/projects')
      .set('x-auth-token', 'test-token');

    expect(listProjects.status).toBe(200);
    expect(listProjects.body.projects).toHaveLength(1);
    expect(listProjects.body.projects[0].id).toBe('my-app');
    expect(listProjects.body.projects[0].gitInitialized).toBe(true);

    const gitStatus = await base
      .get('/api/projects/my-app/git/status')
      .set('x-auth-token', 'test-token');

    expect(gitStatus.status).toBe(200);
    expect(gitStatus.body.branch).toBe('main');
    expect(typeof gitStatus.body.clean).toBe('boolean');

    const createFolder = await base
      .post('/api/projects/my-app/folders')
      .set('x-auth-token', 'test-token')
      .send({
        parentPath: 'src',
        name: 'components',
      });

    expect(createFolder.status).toBe(201);
    expect(createFolder.body.created.path).toBe(path.join('src', 'components'));

    const createFile = await base
      .post('/api/projects/my-app/files')
      .set('x-auth-token', 'test-token')
      .send({
        parentPath: 'src',
        name: 'index.ts',
        contents: 'console.log("hello");\n',
      });

    expect(createFile.status).toBe(201);
    expect(createFile.body.created.path).toBe(path.join('src', 'index.ts'));

    const tree = await base
      .get('/api/projects/my-app/tree')
      .set('x-auth-token', 'test-token');

    expect(tree.status).toBe(200);
    expect(tree.body.tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src', type: 'directory' }),
      expect.objectContaining({ path: path.join('src', 'components'), type: 'directory' }),
      expect.objectContaining({ path: path.join('src', 'index.ts'), type: 'file' }),
    ]));

    const rename = await base
      .patch('/api/projects/my-app/rename')
      .set('x-auth-token', 'test-token')
      .send({
        path: path.join('src', 'index.ts'),
        newName: 'main.ts',
      });

    expect(rename.status).toBe(200);
    expect(rename.body.updated.newPath).toBe(path.join('src', 'main.ts'));

    const selectProject = await base
      .post('/api/session/project')
      .set('x-auth-token', 'test-token')
      .send({
        projectId: 'my-app',
      });

    expect(selectProject.status).toBe(200);
    expect(selectProject.body.shell.cwd).toBe(path.join(process.env.WORKSPACE, 'projects', 'my-app'));

    const previews = await base
      .get('/api/previews')
      .set('x-auth-token', 'test-token');

    expect(previews.status).toBe(200);
    expect(Array.isArray(previews.body.previews)).toBe(true);

    const removeItem = await base
      .delete('/api/projects/my-app/items')
      .set('x-auth-token', 'test-token')
      .send({
        path: path.join('src', 'components'),
        recursive: true,
      });

    expect(removeItem.status).toBe(200);
    expect(removeItem.body.deleted.path).toBe(path.join('src', 'components'));
  });

  it('supports templates, notes, suggestions, tasks, quick switch, duplicate, upload, download, health, and command parsing', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.WORKSPACE = await createWorkspaceFixture();

    await fs.writeFile(path.join(process.env.WORKSPACE, '.bootstrap-status'), 'bootstrap=complete\nhomebrew=installed\n');
    await fs.writeFile(path.join(process.env.WORKSPACE, '.bootstrapped'), '');

    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();
    const base = request(`http://127.0.0.1:${port}`);

    const createTemplateProject = await base
      .post('/api/projects')
      .set('x-auth-token', 'test-token')
      .send({
        name: 'api-app',
        template: 'node-api',
        initializeGit: true,
      });

    expect(createTemplateProject.status).toBe(201);
    await expect(fs.stat(path.join(process.env.WORKSPACE, 'projects', 'api-app', 'package.json'))).resolves.toBeTruthy();

    const tasks = await base
      .get('/api/projects/api-app/tasks')
      .set('x-auth-token', 'test-token');

    expect(tasks.status).toBe(200);
    expect(tasks.body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dev', command: 'npm run dev' }),
      expect.objectContaining({ id: 'test', command: 'npm run test' }),
    ]));

    const suggestions = await base
      .get('/api/projects/api-app/suggestions')
      .set('x-auth-token', 'test-token');

    expect(suggestions.status).toBe(200);
    expect(suggestions.body.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'npm-install' }),
      expect.objectContaining({ id: 'npm-dev' }),
      expect.objectContaining({ id: 'git-status' }),
    ]));

    const putNotes = await base
      .put('/api/projects/api-app/notes')
      .set('x-auth-token', 'test-token')
      .send({
        content: 'remember to add auth',
      });

    expect(putNotes.status).toBe(200);
    expect(putNotes.body.content).toBe('remember to add auth');

    const getNotes = await base
      .get('/api/projects/api-app/notes')
      .set('x-auth-token', 'test-token');

    expect(getNotes.status).toBe(200);
    expect(getNotes.body.content).toBe('remember to add auth');

    const upload = await base
      .post('/api/projects/api-app/upload')
      .set('x-auth-token', 'test-token')
      .send({
        parentPath: 'src',
        name: 'uploaded.txt',
        contentBase64: Buffer.from('hello upload').toString('base64'),
      });

    expect(upload.status).toBe(201);
    expect(upload.body.uploaded.path).toBe(path.join('src', 'uploaded.txt'));

    const duplicate = await base
      .post('/api/projects/api-app/duplicate')
      .set('x-auth-token', 'test-token')
      .send({
        path: path.join('src', 'uploaded.txt'),
        newName: 'uploaded-copy.txt',
      });

    expect(duplicate.status).toBe(201);
    expect(duplicate.body.duplicated.duplicatedPath).toBe(path.join('src', 'uploaded-copy.txt'));

    const download = await base
      .get('/api/projects/api-app/download')
      .set('x-auth-token', 'test-token')
      .query({
        path: path.join('src', 'uploaded-copy.txt'),
      });

    expect(download.status).toBe(200);
    expect(download.text).toBe('hello upload');

    await base
      .post('/api/session/project')
      .set('x-auth-token', 'test-token')
      .send({ projectId: 'api-app' });

    const quickSwitch = await base
      .get('/api/projects/quick-switch')
      .set('x-auth-token', 'test-token');

    expect(quickSwitch.status).toBe(200);
    expect(quickSwitch.body.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'api-app', recent: true }),
    ]));

    const pinProject = await base
      .post('/api/projects/api-app/pin')
      .set('x-auth-token', 'test-token')
      .send({ pinned: true });

    expect(pinProject.status).toBe(200);
    expect(pinProject.body.pinned).toBe(true);

    const workspaceHealth = await base
      .get('/api/workspace/health')
      .set('x-auth-token', 'test-token');

    expect(workspaceHealth.status).toBe(200);
    expect(workspaceHealth.body.bootstrapped).toBe(true);
    expect(workspaceHealth.body.relay.root).toBe(path.join(process.env.WORKSPACE, '.relay'));
    expect(workspaceHealth.body.status.bootstrap).toBe('complete');
    expect(Array.isArray(workspaceHealth.body.managedTools)).toBe(true);
    expect(Array.isArray(workspaceHealth.body.activePorts)).toBe(true);

    const parseGit = await base
      .post('/api/command-results/parse')
      .set('x-auth-token', 'test-token')
      .send({
        command: 'git status',
        output: 'On branch main\nnothing to commit, working tree clean\n',
      });

    expect(parseGit.status).toBe(200);
    expect(parseGit.body.result).toEqual(expect.objectContaining({
      type: 'git-status',
      summary: 'Working tree clean',
    }));

    const previews = await base
      .get('/api/previews')
      .set('x-auth-token', 'test-token');

    expect(previews.status).toBe(200);
    expect(Array.isArray(previews.body.previews)).toBe(true);
  });

  it('supports managed tool catalog, status, validation, and uninstall flows', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.WORKSPACE = await createWorkspaceFixture();

    const relayRoot = path.join(process.env.WORKSPACE, '.relay');
    const relayBin = path.join(relayRoot, 'bin');
    const flutterDir = path.join(process.env.WORKSPACE, '.relay', 'tools', 'flutter', 'bin');
    const nixProfilePath = path.join(relayRoot, 'tools', 'nix-profiles', 'zig');
    await fs.mkdir(relayBin, { recursive: true });
    await fs.mkdir(flutterDir, { recursive: true });
    await fs.mkdir(path.join(nixProfilePath, 'bin'), { recursive: true });
    await fs.writeFile(path.join(flutterDir, 'flutter'), '#!/bin/sh\necho "Flutter 3.22.0"\n', { mode: 0o755 });
    await fs.writeFile(path.join(nixProfilePath, 'bin', 'zig'), '#!/bin/sh\necho "0.13.0"\n', { mode: 0o755 });
    await fs.symlink(path.join(nixProfilePath, 'bin', 'zig'), path.join(relayBin, 'zig'));
    await fs.mkdir(path.join(relayRoot, 'state'), { recursive: true });
    await fs.writeFile(path.join(relayRoot, 'state', 'nix-packages.json'), `${JSON.stringify([{
      id: 'zig',
      name: 'Zig',
      binary: 'zig',
      packageRef: 'nixpkgs#zig',
      profilePath: nixProfilePath,
    }], null, 2)}\n`);

    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();
    const base = request(`http://127.0.0.1:${port}`);

    const catalog = await base
      .get('/api/tools/catalog')
      .set('x-auth-token', 'test-token');

    expect(catalog.status).toBe(200);
    expect(catalog.body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rust' }),
      expect.objectContaining({ id: 'flutter' }),
    ]));
    expect(catalog.body.customToolSupport.installRoot).toBe(path.join(process.env.WORKSPACE, '.relay', 'tools'));
    expect(catalog.body.nixSupport.installRoot).toBe(path.join(process.env.WORKSPACE, '.relay', 'tools', 'nix-profiles'));

    const tools = await base
      .get('/api/tools')
      .set('x-auth-token', 'test-token');

    expect(tools.status).toBe(200);
    expect(tools.body.managedTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rust', installed: false, source: 'unavailable' }),
      expect.objectContaining({ id: 'flutter', installed: true, source: 'relay' }),
    ]));
    expect(tools.body.customTools).toEqual([]);
    expect(tools.body.nixPackages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'zig', installed: true, source: 'relay' }),
    ]));

    await expect(fs.readFile(path.join(process.env.WORKSPACE, '.gemini', 'settings.json'), 'utf8')).resolves.toContain('"selectedType": "oauth-personal"');
    await expect(fs.readFile(path.join(process.env.WORKSPACE, '.relay', 'bin', 'relay-browser'), 'utf8')).resolves.toContain('Browser auth URL');

    const invalidInstall = await base
      .post('/api/tools/install')
      .set('x-auth-token', 'test-token')
      .send({ tool: 'not-real' });

    expect(invalidInstall.status).toBe(400);
    expect(invalidInstall.body.error).toBe('unsupported_tool');

    const uninstallFlutter = await base
      .post('/api/tools/uninstall')
      .set('x-auth-token', 'test-token')
      .send({ tool: 'flutter' });

    expect(uninstallFlutter.status).toBe(200);
    expect(uninstallFlutter.body.ok).toBe(true);
    expect(uninstallFlutter.body.tool.id).toBe('flutter');
    expect(uninstallFlutter.body.tool.installed).toBe(false);

    const installCustom = await base
      .post('/api/tools/custom/install')
      .set('x-auth-token', 'test-token')
      .send({
        id: 'hello-tool',
        name: 'Hello Tool',
        installPath: path.join(process.env.WORKSPACE, '.relay', 'tools', 'hello-tool'),
        binaryPath: path.join(process.env.WORKSPACE, '.relay', 'tools', 'hello-tool', 'bin', 'hello-tool'),
        installCommand: 'mkdir -p bin && printf \'#!/bin/sh\\necho "hello-tool 1.0.0"\\n\' > bin/hello-tool && chmod +x bin/hello-tool',
        versionCommand: `${path.join(process.env.WORKSPACE, '.relay', 'tools', 'hello-tool', 'bin', 'hello-tool')} --version`,
        binLinks: ['hello-tool'],
      });

    expect(installCustom.status).toBe(200);
    expect(installCustom.body.ok).toBe(true);
    expect(installCustom.body.tool.id).toBe('hello-tool');
    expect(installCustom.body.tool.installed).toBe(true);

    const toolsAfterCustom = await base
      .get('/api/tools')
      .set('x-auth-token', 'test-token');

    expect(toolsAfterCustom.status).toBe(200);
    expect(toolsAfterCustom.body.customTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'hello-tool', installed: true, source: 'relay' }),
    ]));

    const uninstallCustom = await base
      .post('/api/tools/custom/uninstall')
      .set('x-auth-token', 'test-token')
      .send({ tool: 'hello-tool' });

    expect(uninstallCustom.status).toBe(200);
    expect(uninstallCustom.body.ok).toBe(true);
    expect(uninstallCustom.body.tool.id).toBe('hello-tool');
    expect(uninstallCustom.body.tool.installed).toBe(false);
  });

  it('uses the Relay shell environment for managed tool install commands', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.WORKSPACE = await createWorkspaceFixture();
    process.env.SHELL = '/bin/bash';

    const relayRoot = path.join(process.env.WORKSPACE, '.relay');
    const relayBin = path.join(relayRoot, 'bin');
    await fs.mkdir(relayBin, { recursive: true });
    await fs.writeFile(path.join(relayBin, 'nix'), `#!/bin/sh
set -eu
PROFILE=""
PACKAGE=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--profile" ]; then
    PROFILE="$2"
    shift 2
    continue
  fi
  PACKAGE="$1"
  shift
done
NAME="$(printf '%s' "$PACKAGE" | awk -F'#' '{print $NF}')"
mkdir -p "$PROFILE/bin"
printf '#!/bin/sh\\necho "%s 1.0.0"\\n' "$NAME" > "$PROFILE/bin/$NAME"
chmod +x "$PROFILE/bin/$NAME"
`, { mode: 0o755 });

    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();
    const base = request(`http://127.0.0.1:${port}`);

    const install = await base
      .post('/api/tools/install')
      .set('x-auth-token', 'test-token')
      .send({ tool: 'rust' });

    expect(install.status).toBe(200);
    expect(install.body.ok).toBe(true);
    expect(install.body.tool.id).toBe('rust');
  });

  it('supports nix package search validation and install flows', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.WORKSPACE = await createWorkspaceFixture();

    const relayRoot = path.join(process.env.WORKSPACE, '.relay');
    const relayBin = path.join(relayRoot, 'bin');
    await fs.mkdir(relayBin, { recursive: true });
    await fs.writeFile(path.join(relayBin, 'nix'), `#!/bin/sh
set -eu
COMMAND="$1"
shift
if [ "$COMMAND" = "search" ]; then
  printf '{"legacyPackages.x86_64-linux.zig":{"pname":"zig","version":"0.13.0","description":"Zig compiler"}}'
  exit 0
fi
PROFILE=""
PACKAGE=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--profile" ]; then
    PROFILE="$2"
    shift 2
    continue
  fi
  PACKAGE="$1"
  shift
done
NAME="$(printf '%s' "$PACKAGE" | awk -F'#' '{print $NF}')"
mkdir -p "$PROFILE/bin"
printf '#!/bin/sh\\necho "%s 0.13.0"\\n' "$NAME" > "$PROFILE/bin/$NAME"
chmod +x "$PROFILE/bin/$NAME"
`, { mode: 0o755 });

    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();
    const base = request(`http://127.0.0.1:${port}`);

    const invalidSearch = await base
      .get('/api/tools/nix/search')
      .set('x-auth-token', 'test-token')
      .query({ q: 'a' });

    expect(invalidSearch.status).toBe(400);
    expect(invalidSearch.body.error).toBe('invalid_search_query');

    const search = await base
      .get('/api/tools/nix/search')
      .set('x-auth-token', 'test-token')
      .query({ q: 'zig' });

    expect(search.status).toBe(200);
    expect(search.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ packageRef: 'nixpkgs#zig' }),
    ]));

    const install = await base
      .post('/api/tools/nix/install')
      .set('x-auth-token', 'test-token')
      .send({
        id: 'zig',
        name: 'Zig',
        packageRef: 'nixpkgs#zig',
        binary: 'zig',
      });

    expect(install.status).toBe(200);
    expect(install.body.tool.id).toBe('zig');
    expect(install.body.tool.installed).toBe(true);

    const tools = await base
      .get('/api/tools')
      .set('x-auth-token', 'test-token');

    expect(tools.status).toBe(200);
    expect(tools.body.nixPackages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'zig', installed: true }),
    ]));

    const uninstall = await base
      .post('/api/tools/nix/uninstall')
      .set('x-auth-token', 'test-token')
      .send({ tool: 'zig' });

    expect(uninstall.status).toBe(200);
    expect(uninstall.body.tool.id).toBe('zig');
    expect(uninstall.body.tool.installed).toBe(false);
  });

  it('supports initializing git later for an existing project', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.WORKSPACE = await createWorkspaceFixture();

    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();
    const base = request(`http://127.0.0.1:${port}`);

    const createProject = await base
      .post('/api/projects')
      .set('x-auth-token', 'test-token')
      .send({
        name: 'plain-app',
        template: 'blank',
        initializeGit: false,
      });

    expect(createProject.status).toBe(201);
    expect(createProject.body.project.gitInitialized).toBe(false);

    const statusBeforeInit = await base
      .get('/api/projects/plain-app/git/status')
      .set('x-auth-token', 'test-token');

    expect(statusBeforeInit.status).toBe(400);
    expect(statusBeforeInit.body.error).toBe('not_a_git_repo');

    const initGit = await base
      .post('/api/projects/plain-app/git/init')
      .set('x-auth-token', 'test-token')
      .send({});

    expect(initGit.status).toBe(200);
    expect(initGit.body.ok).toBe(true);
    expect(initGit.body.project.gitInitialized).toBe(true);
    expect(initGit.body.git.branch).toBe('main');
    expect(initGit.body.git.clean).toBe(true);

    const listProjects = await base
      .get('/api/projects')
      .set('x-auth-token', 'test-token');

    expect(listProjects.status).toBe(200);
    expect(listProjects.body.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'plain-app',
        gitInitialized: true,
      }),
    ]));

    const statusAfterInit = await base
      .get('/api/projects/plain-app/git/status')
      .set('x-auth-token', 'test-token');

    expect(statusAfterInit.status).toBe(200);
    expect(statusAfterInit.body.branch).toBe('main');
    expect(statusAfterInit.body.clean).toBe(true);
  });

  it('supports git APIs and clone by URL', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.WORKSPACE = await createWorkspaceFixture();

    const relay = createRelayServer(() => new FakePty());
    servers.push(relay);
    const port = await relay.start();
    const base = request(`http://127.0.0.1:${port}`);

    const sourceRepo = path.join(process.env.WORKSPACE, 'projects', 'source-repo');
    await fs.mkdir(sourceRepo, { recursive: true });
    await initGitRepo(sourceRepo);
    await fs.writeFile(path.join(sourceRepo, 'README.md'), '# Relay\n');
    await execFile('git', ['add', '--', 'README.md'], { cwd: sourceRepo });
    await execFile('git', ['commit', '-m', 'init'], { cwd: sourceRepo });

    const cloneResponse = await base
      .post('/api/projects/clone')
      .set('x-auth-token', 'test-token')
      .send({
        url: sourceRepo,
        name: 'cloned-repo',
        provider: 'url',
      });

    expect(cloneResponse.status).toBe(201);
    expect(cloneResponse.body.project.id).toBe('cloned-repo');

    const clonedRepo = path.join(process.env.WORKSPACE, 'projects', 'cloned-repo');
    await initGitRepo(clonedRepo);

    await fs.writeFile(path.join(clonedRepo, 'notes.txt'), 'one\n');

    const statusBeforeStage = await base
      .get('/api/projects/cloned-repo/git/status')
      .set('x-auth-token', 'test-token');

    expect(statusBeforeStage.status).toBe(200);
    expect(statusBeforeStage.body.clean).toBe(false);
    expect(statusBeforeStage.body.untracked).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'notes.txt' }),
    ]));

    const stage = await base
      .post('/api/projects/cloned-repo/git/stage')
      .set('x-auth-token', 'test-token')
      .send({
        paths: ['notes.txt'],
      });

    expect(stage.status).toBe(200);
    expect(stage.body.ok).toBe(true);

    const statusAfterStage = await base
      .get('/api/projects/cloned-repo/git/status')
      .set('x-auth-token', 'test-token');

    expect(statusAfterStage.status).toBe(200);
    expect(statusAfterStage.body.staged).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'notes.txt' }),
    ]));

    const diff = await base
      .get('/api/projects/cloned-repo/git/diff')
      .set('x-auth-token', 'test-token')
      .query({ staged: 'true' });

    expect(diff.status).toBe(200);
    expect(typeof diff.body.diff).toBe('string');

    const commit = await base
      .post('/api/projects/cloned-repo/git/commit')
      .set('x-auth-token', 'test-token')
      .send({
        message: 'add notes',
      });

    expect(commit.status).toBe(200);
    expect(commit.body.ok).toBe(true);
    expect(commit.body.commit.message).toBe('add notes');

    const branches = await base
      .get('/api/projects/cloned-repo/git/branches')
      .set('x-auth-token', 'test-token');

    expect(branches.status).toBe(200);
    expect(Array.isArray(branches.body.branches)).toBe(true);

    const checkout = await base
      .post('/api/projects/cloned-repo/git/branch/checkout')
      .set('x-auth-token', 'test-token')
      .send({
        branch: 'feature/test',
        create: true,
      });

    expect(checkout.status).toBe(200);
    expect(checkout.body.branch).toBe('feature/test');

    await fs.writeFile(path.join(clonedRepo, 'notes.txt'), 'two\n');

    const discard = await base
      .post('/api/projects/cloned-repo/git/discard')
      .set('x-auth-token', 'test-token')
      .send({
        paths: ['notes.txt'],
      });

    expect(discard.status).toBe(200);
    expect(discard.body.ok).toBe(true);

    const statusAfterDiscard = await base
      .get('/api/projects/cloned-repo/git/status')
      .set('x-auth-token', 'test-token');

    expect(statusAfterDiscard.status).toBe(200);
    expect(statusAfterDiscard.body.conflicts).toEqual([]);
  });

  it('spawns a shell in the workspace and relays PTY output', async () => {
    process.env.PORT = '0';
    process.env.WORKSPACE = '/tmp/relay-workspace';
    process.env.SHELL = '/bin/sh';
    process.env.AUTH_TOKEN = 'test-token';
    process.env.VSCODE_GIT_IPC_HANDLE = '/tmp/vscode.sock';
    process.env.TERM_PROGRAM = 'vscode';
    process.env.TERM_PROGRAM_VERSION = '1.2.3';
    process.env.PROMPT_COMMAND = 'broken prompt hook';

    const ptys: FakePty[] = [];
    const factory: PtyFactory = (options) => {
      expect(options.command).toBe('/bin/sh');
      expect(options.cwd).toBe('/tmp/relay-workspace');
      expect(options.env.HOME).toBe('/tmp/relay-workspace');
      expect(options.env.RELAY_HOME).toBe('/tmp/relay-workspace/.relay');
      expect(options.env.RELAY_TOOLS).toBe('/tmp/relay-workspace/.relay/tools');
      expect(options.env.RELAY_CACHE).toBe('/tmp/relay-workspace/.relay/cache');
      expect(options.env.RELAY_BIN).toBe('/tmp/relay-workspace/.relay/bin');
      expect(options.env.PROMPT_COMMAND).toBe('');
      expect(options.env.VSCODE_GIT_IPC_HANDLE).toBeUndefined();
      expect(options.env.TERM_PROGRAM).toBeUndefined();
      expect(options.env.TERM_PROGRAM_VERSION).toBeUndefined();
      expect(String(options.env.PATH)).toContain('/tmp/relay-workspace/.relay/bin');
      expect(options.cols).toBe(80);
      expect(options.rows).toBe(24);

      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    };

    const relay = createRelayServer(factory);
    servers.push(relay);
    const port = await relay.start();
    const client = await connectClient(port, 'test-token');
    clients.push(client);

    const output = new Promise<string>((resolve) => {
      client.once('output', resolve);
    });

    ptys[0].pushOutput('hello from shell');

    await expect(output).resolves.toBe('hello from shell');
  });

  it('writes terminal input to the PTY and forwards resize events', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';

    let pty: FakePty | undefined;
    const relay = createRelayServer(() => {
      pty = new FakePty();
      return pty;
    });
    servers.push(relay);
    const port = await relay.start();
    const client = await connectClient(port, 'test-token');
    clients.push(client);

    client.emit('input', 'ls\n');
    client.emit('resize', { cols: 120, rows: 40 });
    client.emit('resize', { cols: 0, rows: 0 });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(pty?.writes).toEqual(['ls\n']);
    expect(pty?.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('emits structured shell transcript events alongside raw output', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';

    let pty: FakePty | undefined;
    const relay = createRelayServer(() => {
      pty = new FakePty();
      return pty;
    });
    servers.push(relay);
    const port = await relay.start();
    const client = await connectClient(port, 'test-token');
    clients.push(client);
    const events: Array<Record<string, unknown>> = [];
    client.on('shell_event', (event) => {
      events.push(event);
    });

    client.emit('input', 'pwd\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    pty?.pushOutput('/workspace/projects/demo\n');
    pty?.pushOutput('\u001b]9;9;relay-prompt|/workspace/projects/demo|0\u0007');

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events).toContainEqual(expect.objectContaining({
      type: 'command_started',
      command: 'pwd',
      source: 'terminal',
    }));
    const outputText = events
      .filter((event) => event.type === 'command_output')
      .map((event) => String(event.chunk || ''))
      .join('');
    expect(outputText).toBe('/workspace/projects/demo\n');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'command_finished',
      exitCode: 0,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'cwd_changed',
      cwd: '/workspace/projects/demo',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'prompt',
      cwd: '/workspace/projects/demo',
    }));
  });

  it('kills the PTY on socket disconnect', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';

    let pty: FakePty | undefined;
    const relay = createRelayServer(() => {
      pty = new FakePty();
      return pty;
    });
    servers.push(relay);
    const port = await relay.start();
    const client = await connectClient(port, 'test-token');

    client.disconnect();

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(pty?.killed).toBe(true);
  });

  it('rejects socket connections with an invalid token', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';

    const relay = createRelayServer(() => {
      throw new Error('should not spawn');
    });
    servers.push(relay);
    const port = await relay.start();
    const client = createClient(`http://127.0.0.1:${port}`, {
      auth: {
        token: 'wrong-token',
      },
      reconnection: false,
      transports: ['websocket'],
    });
    clients.push(client);

    const connectError = new Promise<Error>((resolve) => {
      client.once('connect_error', resolve);
    });

    await expect(connectError).resolves.toMatchObject({ message: 'Unauthorized' });
  });

  it('disconnects the client if shell spawn fails', async () => {
    process.env.PORT = '0';
    process.env.AUTH_TOKEN = 'test-token';

    const relay = createRelayServer(() => {
      throw new Error('spawn failed');
    });
    servers.push(relay);
    const port = await relay.start();
    const client = createClient(`http://127.0.0.1:${port}`, {
      auth: {
        token: 'test-token',
      },
      reconnection: false,
      transports: ['websocket'],
    });
    clients.push(client);

    const output = new Promise<string>((resolve) => {
      client.once('output', resolve);
    });

    const disconnect = new Promise<string>((resolve) => {
      client.once('disconnect', resolve);
    });

    await expect(output).resolves.toContain('Failed to start shell');
    await expect(disconnect).resolves.toBe('io server disconnect');
  });
});
