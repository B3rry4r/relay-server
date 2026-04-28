#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const authToken = process.env.AUTH_TOKEN || '';
const backendUrl = new URL(
  process.env.RELAY_BACKEND_URL
    || process.env.BACKEND_URL
    || `http://127.0.0.1:${process.env.PORT || '8080'}`,
);

if (!authToken) {
  console.error('[relay-mcp] AUTH_TOKEN is required.');
  process.exit(1);
}

function backendHeaders() {
  return {
    'x-auth-token': authToken,
    'content-type': 'application/json',
  };
}

async function backendJson(path, init = {}) {
  const response = await fetch(new URL(path, backendUrl), {
    ...init,
    headers: {
      ...backendHeaders(),
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Backend request failed with ${response.status}`);
  }

  return text ? JSON.parse(text) : null;
}

async function backendText(path, init = {}) {
  const response = await fetch(new URL(path, backendUrl), {
    ...init,
    headers: {
      ...backendHeaders(),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Backend request failed with ${response.status}`);
  }
  return text;
}

class RelaySocketBridge {
  constructor() {
    this.socket = io(backendUrl.origin, {
      auth: { token: authToken },
      path: '/socket.io',
      transports: ['websocket'],
    });
    this.connected = new Promise((resolve) => {
      if (this.socket.connected) {
        resolve();
        return;
      }
      this.socket.once('connect', resolve);
    });
    this.socket.on('connect_error', (error) => {
      console.error('[relay-mcp] socket connect error:', error.message);
    });
  }

  async connect(timeoutMs = 15000) {
    await Promise.race([
      this.connected,
      delay(timeoutMs).then(() => {
        throw new Error(`Timed out connecting to Relay Socket.IO at ${backendUrl.origin}`);
      }),
    ]);
  }

  async waitFor(eventName, action, timeoutMs = 15000) {
    await this.connect();
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.socket.off(eventName, onEvent);
        reject(new Error(`Timed out waiting for ${eventName}`));
      }, timeoutMs);

      const onEvent = (payload) => {
        clearTimeout(timeout);
        this.socket.off(eventName, onEvent);
        resolve(payload);
      };

      this.socket.on(eventName, onEvent);

      try {
        action();
      } catch (error) {
        clearTimeout(timeout);
        this.socket.off(eventName, onEvent);
        reject(error);
      }
    });
  }

  async createTerminal(cwd) {
    return await this.waitFor('terminal:created', () => {
      this.socket.emit('terminal:create', cwd ? { cwd } : {});
    });
  }

  async selectTerminal(id) {
    return await this.waitFor('terminal:selected', () => {
      this.socket.emit('terminal:select', { id });
    });
  }

  async closeTerminal(id) {
    return await this.waitFor('terminal:closed', () => {
      this.socket.emit('terminal:close', { id });
    });
  }

  async sendInput(data) {
    await this.connect();
    this.socket.emit('input', data);
  }

  async sendCd(payload) {
    await this.connect();
    this.socket.emit('cd', payload);
  }

  async disconnect() {
    this.socket.disconnect();
  }
}

function textResult(summary, structuredContent) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    _meta: { summary },
  };
}

const terminalBridge = new RelaySocketBridge();
const server = new McpServer(
  {
    name: 'relay-platform',
    version: '1.0.0',
  },
  {
    instructions:
      'Start with relay_workspace_snapshot. Use project and terminal tools to inspect or drive the live Relay workspace. Use Flutter tools for Flutter projects and preview tools for app-port testing.',
  },
);

server.registerTool(
  'relay_workspace_snapshot',
  {
    title: 'Workspace Snapshot',
    description: 'Return a live snapshot of the Relay workspace, projects, terminals, previews, Git state, and Flutter context.',
    inputSchema: z.object({
      activeProjectId: z.string().nullable().optional(),
      activeTerminalId: z.string().nullable().optional(),
      currentView: z.string().nullable().optional(),
      gitSelectedPath: z.string().nullable().optional(),
      previewPort: z.string().nullable().optional(),
      previewViewportMode: z.enum(['fit', 'portrait', 'landscape']).nullable().optional(),
      sheet: z.string().nullable().optional(),
    }),
  },
  async (args = {}) => {
    const snapshot = await backendJson('/api/context/snapshot', {
      method: 'POST',
      body: JSON.stringify({
        activeProjectId: args.activeProjectId ?? null,
        activeTerminalId: args.activeTerminalId ?? null,
        currentView: args.currentView ?? 'workspace',
        gitSelectedPath: args.gitSelectedPath ?? null,
        previewPort: args.previewPort ?? null,
        previewViewportMode: args.previewViewportMode ?? null,
        sheet: args.sheet ?? 'context',
      }),
    });

    return textResult('Workspace snapshot returned.', snapshot);
  },
);

server.registerTool(
  'relay_projects_list',
  {
    title: 'List Projects',
    description: 'List workspace projects visible to Relay.',
  },
  async () => {
    const data = await backendJson('/api/projects');
    return textResult('Project list returned.', data);
  },
);

server.registerTool(
  'relay_project_select',
  {
    title: 'Select Project',
    description: 'Mark a project as active in Relay.',
    inputSchema: z.object({
      projectId: z.string().min(1),
    }),
  },
  async ({ projectId }) => {
    const data = await backendJson('/api/session/project', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    });
    return textResult(`Project ${projectId} selected.`, data);
  },
);

server.registerTool(
  'relay_project_tree',
  {
    title: 'Project Tree',
    description: 'Return a project tree for inspection.',
    inputSchema: z.object({
      projectId: z.string().min(1),
      path: z.string().optional(),
      depth: z.number().int().min(1).max(10).optional(),
    }),
  },
  async ({ projectId, path = '', depth = 2 }) => {
    const data = await backendJson(`/api/projects/${encodeURIComponent(projectId)}/tree?path=${encodeURIComponent(path)}&depth=${depth}`);
    return textResult(`Tree for ${projectId} returned.`, data);
  },
);

server.registerTool(
  'relay_project_file',
  {
    title: 'Project File',
    description: 'Read a file from a project.',
    inputSchema: z.object({
      projectId: z.string().min(1),
      path: z.string().min(1),
    }),
  },
  async ({ projectId, path }) => {
    const data = await backendJson(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`);
    return textResult(`File ${path} returned.`, data);
  },
);

server.registerTool(
  'relay_terminals_list',
  {
    title: 'List Terminals',
    description: 'List active Relay terminals and their current state.',
  },
  async () => {
    const data = await backendJson('/api/context/snapshot', {
      method: 'POST',
      body: JSON.stringify({
        currentView: 'terminal',
        sheet: 'context',
      }),
    });
    return textResult('Terminal snapshot returned.', {
      selectedTerminal: data.selectedTerminal,
      terminals: data.terminals,
    });
  },
);

server.registerTool(
  'relay_terminal_create',
  {
    title: 'Create Terminal',
    description: 'Open a new Relay terminal, optionally in a project directory.',
    inputSchema: z.object({
      cwd: z.string().optional(),
      projectId: z.string().optional(),
    }),
  },
  async ({ cwd, projectId }) => {
    const session = await terminalBridge.createTerminal(cwd || undefined);
    if (projectId && !cwd) {
      await terminalBridge.sendCd({ projectId, path: cwd || '' });
    }
    return textResult('Terminal created.', session);
  },
);

server.registerTool(
  'relay_terminal_select',
  {
    title: 'Select Terminal',
    description: 'Switch the active terminal session.',
    inputSchema: z.object({
      terminalId: z.string().min(1),
    }),
  },
  async ({ terminalId }) => {
    const data = await terminalBridge.selectTerminal(terminalId);
    return textResult(`Terminal ${terminalId} selected.`, data);
  },
);

server.registerTool(
  'relay_terminal_close',
  {
    title: 'Close Terminal',
    description: 'Close an active terminal session.',
    inputSchema: z.object({
      terminalId: z.string().min(1),
    }),
  },
  async ({ terminalId }) => {
    const data = await terminalBridge.closeTerminal(terminalId);
    return textResult(`Terminal ${terminalId} closed.`, data);
  },
);

server.registerTool(
  'relay_terminal_run',
  {
    title: 'Run Command',
    description: 'Create or reuse a terminal, optionally switch to a project, and send a shell command.',
    inputSchema: z.object({
      command: z.string().min(1),
      cwd: z.string().optional(),
      projectId: z.string().optional(),
      createTerminal: z.boolean().optional(),
      settleMs: z.number().int().min(0).max(30000).optional(),
    }),
  },
  async ({ command, cwd, projectId, createTerminal = false, settleMs = 1200 }) => {
    if (createTerminal || cwd || projectId) {
      const session = await terminalBridge.createTerminal(cwd || undefined);
      if (projectId && !cwd) {
        await terminalBridge.sendCd({ projectId, path: cwd || '' });
      }
      if (session?.id) {
        await terminalBridge.selectTerminal(session.id);
      }
    }

    await terminalBridge.sendInput(`${command}\n`);
    if (settleMs > 0) {
      await delay(settleMs);
    }

    const snapshot = await backendJson('/api/context/snapshot', {
      method: 'POST',
      body: JSON.stringify({
        activeTerminalId: null,
        currentView: 'terminal',
        sheet: 'context',
      }),
    });
    return textResult('Command sent to terminal.', snapshot);
  },
);

server.registerTool(
  'relay_preview_list',
  {
    title: 'List Previews',
    description: 'List active preview ports.',
  },
  async () => {
    const data = await backendJson('/api/previews');
    return textResult('Preview list returned.', data);
  },
);

server.registerTool(
  'relay_preview_serve_port',
  {
    title: 'Serve Port',
    description: 'Start a simple preview server on a port if nothing is already listening.',
    inputSchema: z.object({
      port: z.number().int().min(1).max(65535),
    }),
  },
  async ({ port }) => {
    const data = await backendJson(`/api/previews/${port}/serve`, {
      method: 'POST',
      body: '{}',
    });
    return textResult(`Preview port ${port} started or already active.`, data);
  },
);

server.registerTool(
  'relay_flutter_status',
  {
    title: 'Flutter Status',
    description: 'Return the current Flutter SDK status in Relay.',
  },
  async () => {
    const data = await backendJson('/api/flutter/status');
    return textResult('Flutter status returned.', data);
  },
);

server.registerTool(
  'relay_flutter_project',
  {
    title: 'Flutter Project Check',
    description: 'Check whether a project is a Flutter project and whether it has a build.',
    inputSchema: z.object({
      projectId: z.string().min(1),
    }),
  },
  async ({ projectId }) => {
    const data = await backendJson(`/api/projects/${encodeURIComponent(projectId)}/flutter`);
    return textResult(`Flutter status for ${projectId} returned.`, data);
  },
);

server.registerTool(
  'relay_flutter_build_web',
  {
    title: 'Build Flutter Web',
    description: 'Run a Flutter web release build for a project.',
    inputSchema: z.object({
      projectId: z.string().min(1),
    }),
  },
  async ({ projectId }) => {
    const data = await backendJson(`/api/projects/${encodeURIComponent(projectId)}/flutter/build`, {
      method: 'POST',
      body: '{}',
    });
    return textResult(`Flutter web build for ${projectId} completed.`, data);
  },
);

server.registerTool(
  'relay_flutter_serve_web',
  {
    title: 'Serve Flutter Web',
    description: 'Start the Flutter web dev server for a project.',
    inputSchema: z.object({
      projectId: z.string().min(1),
      port: z.number().int().min(1).max(65535).optional(),
    }),
  },
  async ({ projectId, port }) => {
    const data = await backendJson(`/api/projects/${encodeURIComponent(projectId)}/flutter/serve`, {
      method: 'POST',
      body: JSON.stringify(port ? { port } : {}),
    });
    return textResult(`Flutter dev server for ${projectId} started or already active.`, data);
  },
);

server.registerTool(
  'relay_flutter_reload',
  {
    title: 'Flutter Hot Reload',
    description: 'Trigger a Flutter hot reload for a running dev server.',
    inputSchema: z.object({
      projectId: z.string().min(1),
    }),
  },
  async ({ projectId }) => {
    const data = await backendJson(`/api/projects/${encodeURIComponent(projectId)}/flutter/reload`, {
      method: 'POST',
      body: '{}',
    });
    return textResult(`Flutter hot reload requested for ${projectId}.`, data);
  },
);

server.registerTool(
  'relay_flutter_restart',
  {
    title: 'Flutter Hot Restart',
    description: 'Trigger a Flutter hot restart for a running dev server.',
    inputSchema: z.object({
      projectId: z.string().min(1),
    }),
  },
  async ({ projectId }) => {
    const data = await backendJson(`/api/projects/${encodeURIComponent(projectId)}/flutter/restart`, {
      method: 'POST',
      body: '{}',
    });
    return textResult(`Flutter hot restart requested for ${projectId}.`, data);
  },
);

server.registerTool(
  'relay_flutter_stop',
  {
    title: 'Stop Flutter Dev Server',
    description: 'Stop a running Flutter dev server.',
    inputSchema: z.object({
      projectId: z.string().min(1),
    }),
  },
  async ({ projectId }) => {
    const data = await backendJson(`/api/projects/${encodeURIComponent(projectId)}/flutter/stop`, {
      method: 'POST',
      body: '{}',
    });
    return textResult(`Flutter dev server stopped for ${projectId}.`, data);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error('[relay-mcp] connected to', backendUrl.origin);

process.on('SIGINT', async () => {
  await terminalBridge.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await terminalBridge.disconnect();
  process.exit(0);
});
