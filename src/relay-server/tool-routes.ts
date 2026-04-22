import type { Express } from 'express';
import {
  MANAGED_TOOL_IDS,
  type ManagedToolId,
} from './types';
import {
  getNixPackageProfilesRoot,
  getNixPackagesRegistryPath,
  getRelayBinRoot,
  getRelayToolsRoot,
  requireAuth,
  resolveWorkspace,
} from './runtime';
import { parseCommandResult } from './monitoring';
import { ensureRelayRuntimeAssets, getManagedToolCatalog } from './tooling';
import {
  installManagedTool,
  listManagedToolStatuses,
  searchNixPackages,
  uninstallManagedTool,
} from './tooling-management';
import {
  installCustomTool,
  installNixPackage,
  listCustomToolStatuses,
  listNixPackageStatuses,
  uninstallCustomTool,
  uninstallNixPackage,
} from './tooling-custom';

export function registerToolRoutes(app: Express): void {
  app.get('/api/tools/catalog', requireAuth, async (_req, res) => {
    const workspace = resolveWorkspace();
    await ensureRelayRuntimeAssets(workspace);
    res.json({
      tools: getManagedToolCatalog(workspace).map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        installMethod: tool.installMethod,
        installPath: tool.installPath,
        supported: tool.supported,
      })),
      customToolSupport: {
        installRoot: getRelayToolsRoot(workspace),
        binRoot: getRelayBinRoot(workspace),
        statePath: `${workspace}/.relay/state/custom-tools.json`,
      },
      nixSupport: {
        installRoot: getNixPackageProfilesRoot(workspace),
        statePath: getNixPackagesRegistryPath(workspace),
        searchEndpoint: '/api/tools/nix/search',
        installEndpoint: '/api/tools/nix/install',
      },
    });
  });

  app.get('/api/tools', requireAuth, async (_req, res) => {
    const workspace = resolveWorkspace();
    res.json({
      managedTools: await listManagedToolStatuses(workspace),
      customTools: await listCustomToolStatuses(workspace),
      nixPackages: await listNixPackageStatuses(workspace),
    });
  });

  app.get('/api/tools/nix/search', requireAuth, async (req, res) => {
    try {
      res.json({
        query: typeof req.query.q === 'string' ? req.query.q : '',
        results: await searchNixPackages(resolveWorkspace(), typeof req.query.q === 'string' ? req.query.q : ''),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nix search failed.';
      const statusCode = message === 'invalid_search_query' ? 400 : message === 'nix_unavailable' ? 503 : 500;
      res.status(statusCode).json({
        error: statusCode === 400 ? 'invalid_search_query' : statusCode === 503 ? 'nix_unavailable' : 'nix_search_failed',
        message: statusCode === 400 ? 'Search query must be at least 2 characters.' : statusCode === 503 ? 'Nix is not installed in the Relay runtime.' : message,
      });
    }
  });

  app.post('/api/tools/nix/install', requireAuth, async (req, res) => {
    try {
      const tool = await installNixPackage(resolveWorkspace(), {
        id: typeof req.body?.id === 'string' ? req.body.id : undefined,
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
        packageRef: String(req.body?.packageRef || ''),
        binary: String(req.body?.binary || ''),
        versionArgs: Array.isArray(req.body?.versionArgs)
          ? req.body.versionArgs.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
          : undefined,
      });
      res.status(200).json({ ok: true, tool });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nix install failed.';
      const statusCode = ['invalid_nix_package', 'nix_binary_not_found'].includes(message) ? 400 : message === 'nix_unavailable' ? 503 : 500;
      res.status(statusCode).json({
        error: statusCode === 400 ? message : statusCode === 503 ? 'nix_unavailable' : 'nix_install_failed',
        message: statusCode === 400 ? (message === 'nix_binary_not_found' ? 'Installed package does not provide the requested binary.' : 'Nix package request is invalid.') : statusCode === 503 ? 'Nix is not installed in the Relay runtime.' : message,
      });
    }
  });

  app.post('/api/tools/nix/uninstall', requireAuth, async (req, res) => {
    try {
      res.status(200).json({ ok: true, tool: await uninstallNixPackage(resolveWorkspace(), String(req.body?.tool || '')) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nix uninstall failed.';
      const statusCode = ['invalid_nix_package', 'nix_package_not_found'].includes(message) ? 400 : 500;
      res.status(statusCode).json({
        error: statusCode === 400 ? message : 'nix_uninstall_failed',
        message: statusCode === 400 ? (message === 'nix_package_not_found' ? 'Installed nix package not found.' : 'Nix package request is invalid.') : message,
      });
    }
  });

  app.post('/api/tools/install', requireAuth, async (req, res) => {
    const toolId = String(req.body?.tool || '') as ManagedToolId;
    if (!MANAGED_TOOL_IDS.includes(toolId)) {
      res.status(400).json({ error: 'unsupported_tool', message: 'The requested tool is not supported.' });
      return;
    }
    try {
      res.status(200).json({ ok: true, tool: await installManagedTool(resolveWorkspace(), toolId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool installation failed.';
      const statusCode = message === 'unsupported_tool' ? 400 : 500;
      res.status(statusCode).json({ error: statusCode === 400 ? 'unsupported_tool' : 'tool_install_failed', message: statusCode === 400 ? 'The requested tool is not supported.' : message });
    }
  });

  app.post('/api/tools/uninstall', requireAuth, async (req, res) => {
    const toolId = String(req.body?.tool || '') as ManagedToolId;
    if (!MANAGED_TOOL_IDS.includes(toolId)) {
      res.status(400).json({ error: 'unsupported_tool', message: 'The requested tool is not supported.' });
      return;
    }
    try {
      res.status(200).json({ ok: true, tool: await uninstallManagedTool(resolveWorkspace(), toolId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool removal failed.';
      const statusCode = message === 'unsupported_tool' ? 400 : 500;
      res.status(statusCode).json({ error: statusCode === 400 ? 'unsupported_tool' : 'tool_uninstall_failed', message: statusCode === 400 ? 'The requested tool is not supported.' : message });
    }
  });

  app.post('/api/tools/custom/install', requireAuth, async (req, res) => {
    try {
      const tool = await installCustomTool(resolveWorkspace(), {
        id: String(req.body?.id || ''),
        name: String(req.body?.name || ''),
        description: typeof req.body?.description === 'string' ? req.body.description : undefined,
        installCommand: String(req.body?.installCommand || ''),
        installPath: typeof req.body?.installPath === 'string' ? req.body.installPath : undefined,
        binaryPath: String(req.body?.binaryPath || ''),
        uninstallCommand: typeof req.body?.uninstallCommand === 'string' ? req.body.uninstallCommand : undefined,
        versionCommand: typeof req.body?.versionCommand === 'string' ? req.body.versionCommand : undefined,
        ...(Array.isArray(req.body?.binLinks) ? { binLinks: req.body.binLinks } : {}),
      });
      res.status(200).json({ ok: true, tool });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Custom tool installation failed.';
      const statusCode = ['invalid_custom_tool', 'invalid_install_path', 'invalid_binary_path', 'invalid_link_name'].includes(message) ? 400 : 500;
      res.status(statusCode).json({ error: statusCode === 400 ? message : 'custom_tool_install_failed', message: statusCode === 400 ? 'Custom tool request is invalid.' : message });
    }
  });

  app.post('/api/tools/custom/uninstall', requireAuth, async (req, res) => {
    try {
      res.status(200).json({ ok: true, tool: await uninstallCustomTool(resolveWorkspace(), String(req.body?.tool || '')) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Custom tool removal failed.';
      const statusCode = ['invalid_custom_tool', 'custom_tool_not_found'].includes(message) ? 400 : 500;
      res.status(statusCode).json({
        error: statusCode === 400 ? message : 'custom_tool_uninstall_failed',
        message: statusCode === 400 ? (message === 'custom_tool_not_found' ? 'Custom tool not found.' : 'Custom tool request is invalid.') : message,
      });
    }
  });

  app.post('/api/command-results/parse', requireAuth, async (req, res) => {
    res.json({ result: parseCommandResult(String(req.body?.command || ''), String(req.body?.output || '')) });
  });
}
