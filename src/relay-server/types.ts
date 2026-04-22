import type { Server as HttpServer } from 'node:http';
import type { Express } from 'express';
import type { Server as SocketIOServer } from 'socket.io';

export type PtyLike = {
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit?(callback: (event: { exitCode: number; signal?: number }) => void): void;
  resize(cols: number, rows: number): void;
  write(data: string): void;
};

export type PtyFactory = (options: {
  cols: number;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  rows: number;
}) => PtyLike;

export type RelayServer = {
  app: Express;
  httpServer: HttpServer;
  io: SocketIOServer;
  start(): Promise<number>;
  stop(): Promise<void>;
};

export type TreeNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
};

export type GitFileEntry = {
  path: string;
  status: string;
};

export type ActiveCommand = {
  command: string;
  commandId: string;
  startedAt: number;
};

export type ShellTranscriptState = {
  activeCommand: ActiveCommand | null;
  currentCwd: string;
  inputBuffer: string;
  markerBuffer: string;
  nextCommandNumber: number;
};

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
export const RECENT_PROJECT_LIMIT = 10;
export const RELAY_PROMPT_MARKER_PREFIX = '\u001b]9;9;relay-prompt|';

export const MANAGED_TOOL_IDS = [
  'php',
  'python',
  'go',
  'rust',
  'java',
  'flutter',
] as const;

export type ManagedToolId = typeof MANAGED_TOOL_IDS[number];

export type ManagedToolDefinition = {
  binary: string;
  category: 'package-manager' | 'language' | 'sdk';
  description: string;
  id: ManagedToolId;
  installMethod: 'git' | 'nix' | 'system';
  name: string;
  nixPackage?: string;
  pathResolver: (workspace: string) => string;
  supported: boolean;
  versionArgs: string[];
};

export type ManagedToolStatus = {
  category: ManagedToolDefinition['category'];
  description: string;
  id: ManagedToolId;
  kind: 'managed';
  installMethod: ManagedToolDefinition['installMethod'];
  installPath: string;
  installed: boolean;
  name: string;
  source: 'relay' | 'system' | 'unavailable';
  supported: boolean;
  version: string | null;
};

export type CustomToolRecord = {
  binLinks: string[];
  binaryPath: string;
  description: string;
  id: string;
  installCommand: string;
  installPath: string;
  name: string;
  uninstallCommand?: string;
  versionCommand?: string;
};

export type CustomToolStatus = {
  description: string;
  id: string;
  kind: 'custom';
  installMethod: 'custom';
  installPath: string;
  installed: boolean;
  name: string;
  source: 'relay' | 'unavailable';
  supported: true;
  version: string | null;
};

export type NixPackageRecord = {
  binary: string;
  id: string;
  name: string;
  packageRef: string;
  profilePath: string;
  versionArgs?: string[];
};

export type NixPackageStatus = {
  binary: string;
  id: string;
  kind: 'nix-package';
  installMethod: 'nix';
  installPath: string;
  installed: boolean;
  name: string;
  packageRef: string;
  source: 'relay' | 'unavailable';
  version: string | null;
};
