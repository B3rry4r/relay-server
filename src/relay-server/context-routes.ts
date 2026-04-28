import type { Express } from 'express';
import { getWorkspaceHealth } from './monitoring';
import { getGitBranches, getGitStatus } from './git';
import { getActiveTerminals } from './socket';
import { listListeningPorts, listProjects } from './projects';
import { exists, requireAuth, resolveProjectRoot, resolveWorkspace } from './runtime';

type ContextSnapshotRequest = {
  activeProjectId?: string | null;
  activeTerminalId?: string | null;
  currentView?: string | null;
  gitSelectedPath?: string | null;
  previewPort?: string | null;
  previewViewportMode?: 'fit' | 'portrait' | 'landscape' | null;
  selectedItem?: {
    name?: string;
    path?: string;
    type?: 'file' | 'directory';
  } | null;
  sheet?: string | null;
  flutter?: {
    sdkInstalled?: boolean;
    sdkVersion?: string;
    sdkHome?: string;
    isProject?: boolean;
    buildDir?: string;
    hasBuild?: boolean;
    isBuilding?: boolean;
    isServing?: boolean;
    previewPort?: string;
    previewUrl?: string;
    previewIndexUrl?: string;
    buildMessage?: string;
    error?: string;
  } | null;
};

function normalizeRequest(body: unknown): ContextSnapshotRequest {
  const source = (body ?? {}) as Record<string, unknown>;
  const selectedItem = source.selectedItem && typeof source.selectedItem === 'object'
    ? source.selectedItem as Record<string, unknown>
    : null;
  const flutter = source.flutter && typeof source.flutter === 'object'
    ? source.flutter as Record<string, unknown>
    : null;

  return {
    activeProjectId: typeof source.activeProjectId === 'string' ? source.activeProjectId : null,
    activeTerminalId: typeof source.activeTerminalId === 'string' ? source.activeTerminalId : null,
    currentView: typeof source.currentView === 'string' ? source.currentView : null,
    gitSelectedPath: typeof source.gitSelectedPath === 'string' ? source.gitSelectedPath : null,
    previewPort: typeof source.previewPort === 'string' ? source.previewPort : null,
    previewViewportMode:
      source.previewViewportMode === 'fit' ||
      source.previewViewportMode === 'portrait' ||
      source.previewViewportMode === 'landscape'
        ? source.previewViewportMode
        : null,
    selectedItem: selectedItem ? {
      name: typeof selectedItem.name === 'string' ? selectedItem.name : undefined,
      path: typeof selectedItem.path === 'string' ? selectedItem.path : undefined,
      type: selectedItem.type === 'file' || selectedItem.type === 'directory' ? selectedItem.type : undefined,
    } : null,
    sheet: typeof source.sheet === 'string' ? source.sheet : null,
    flutter: flutter ? {
      sdkInstalled: typeof flutter.sdkInstalled === 'boolean' ? flutter.sdkInstalled : undefined,
      sdkVersion: typeof flutter.sdkVersion === 'string' ? flutter.sdkVersion : undefined,
      sdkHome: typeof flutter.sdkHome === 'string' ? flutter.sdkHome : undefined,
      isProject: typeof flutter.isProject === 'boolean' ? flutter.isProject : undefined,
      buildDir: typeof flutter.buildDir === 'string' ? flutter.buildDir : undefined,
      hasBuild: typeof flutter.hasBuild === 'boolean' ? flutter.hasBuild : undefined,
      isBuilding: typeof flutter.isBuilding === 'boolean' ? flutter.isBuilding : undefined,
      isServing: typeof flutter.isServing === 'boolean' ? flutter.isServing : undefined,
      previewPort: typeof flutter.previewPort === 'string' ? flutter.previewPort : undefined,
      previewUrl: typeof flutter.previewUrl === 'string' ? flutter.previewUrl : undefined,
      previewIndexUrl: typeof flutter.previewIndexUrl === 'string' ? flutter.previewIndexUrl : undefined,
      buildMessage: typeof flutter.buildMessage === 'string' ? flutter.buildMessage : undefined,
      error: typeof flutter.error === 'string' ? flutter.error : undefined,
    } : null,
  };
}

export function registerContextRoutes(app: Express): void {
  app.post('/api/context/snapshot', requireAuth, async (req, res) => {
    const workspace = resolveWorkspace();
    const request = normalizeRequest(req.body);
    const [health, projects, activePorts, terminals] = await Promise.all([
      getWorkspaceHealth(),
      listProjects(),
      listListeningPorts(),
      Promise.resolve(getActiveTerminals()),
    ]);

    const activeProjectId = request.activeProjectId ?? null;
    const activeProjectRoot = activeProjectId ? resolveProjectRoot(activeProjectId) : null;
    const projectExists = Boolean(activeProjectRoot && await exists(activeProjectRoot));
    const selectedTerminal = request.activeTerminalId
      ? terminals.find((terminal) => terminal.id === request.activeTerminalId) ?? null
      : null;

    let git = null;
    if (projectExists && activeProjectRoot) {
      try {
        git = {
          status: await getGitStatus(activeProjectRoot),
          branches: await getGitBranches(activeProjectRoot),
        };
      } catch {
        git = null;
      }
    }

    res.json({
      generatedAt: new Date().toISOString(),
      server: {
        workspace,
        bootstrapped: health.bootstrapped,
        activePorts,
        terminalCount: terminals.length,
      },
      health,
      projects,
      activeProject: projectExists && activeProjectRoot
        ? {
            id: activeProjectId,
            path: activeProjectRoot,
            git,
          }
        : null,
      selectedTerminal,
      terminals,
      previews: activePorts.map((port) => ({
        port,
        label: `Port ${port}`,
        url: `/preview/${port}`,
        status: 'active',
      })),
      client: request,
    });
  });
}
