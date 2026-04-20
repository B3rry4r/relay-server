import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io as createClient, type Socket } from 'socket.io-client';
import { createRelayServer, FakePty, type PtyFactory, type RelayServer } from '../src/relay-server';

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
      expect(options.env.PROMPT_COMMAND).toBe('');
      expect(options.env.VSCODE_GIT_IPC_HANDLE).toBeUndefined();
      expect(options.env.TERM_PROGRAM).toBeUndefined();
      expect(options.env.TERM_PROGRAM_VERSION).toBeUndefined();
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
