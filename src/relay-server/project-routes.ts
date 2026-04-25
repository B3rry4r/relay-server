import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express } from 'express';
import { marked } from 'marked';
import { initializeGitRepository } from './git';
import {
  buildTree,
  duplicateItem,
  inferSuggestions,
  inferTasks,
  readProjectNotes,
  scaffoldTemplate,
  writeProjectNotes,
} from './projects';
import {
  ensureProjectsRoot,
  exists,
  getProjectsRoot,
  readStringParam,
  requireAuth,
  resolveProjectRelativePath,
  resolveProjectRoot,
  validateProjectName,
} from './runtime';

export function registerProjectRoutes(app: Express): void {
  app.post('/api/projects', requireAuth, async (req, res) => {
    const projectName = validateProjectName(String(req.body?.name || ''));
    if (!projectName) {
      res.status(400).json({
        error: 'invalid_project_name',
        message: 'Project names may only contain letters, numbers, hyphens, underscores, and periods.',
      });
      return;
    }

    const projectPath = path.join(getProjectsRoot(), projectName);
    if (await exists(projectPath)) {
      res.status(409).json({ error: 'project_exists', message: 'A project with this name already exists.' });
      return;
    }

    await fs.mkdir(projectPath, { recursive: true });
    await scaffoldTemplate(projectPath, String(req.body?.template || 'blank'));

    if (req.body?.initializeGit === true) {
      try {
        await initializeGitRepository(projectPath);
      } catch (error) {
        await fs.rm(projectPath, { recursive: true, force: true });
        res.status(500).json({
          error: 'git_init_failed',
          message: error instanceof Error ? error.message : 'Git initialization failed.',
        });
        return;
      }
    }

    res.status(201).json({
      project: { id: projectName, name: projectName, path: projectPath, gitInitialized: req.body?.initializeGit === true },
    });
  });

  app.get('/api/projects/:projectId/tree', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
    const depth = Number.isInteger(Number(req.query.depth)) ? Number(req.query.depth) : 2;
    res.json({
      project: { id: projectId, path: projectRoot },
      tree: await buildTree(projectRoot, requestedPath, Math.max(depth, 1)),
    });
  });

  app.post('/api/projects/:projectId/files', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const name = String(req.body?.name || '').trim();
    const parentAbsolutePath = resolveProjectRelativePath(projectRoot, String(req.body?.parentPath || ''));
    if (!name) {
      res.status(400).json({ error: 'invalid_name', message: 'File name is required.' });
      return;
    }
    if (!parentAbsolutePath) {
      res.status(400).json({ error: 'invalid_path', message: 'Parent path is invalid.' });
      return;
    }

    await fs.mkdir(parentAbsolutePath, { recursive: true });
    const targetPath = path.join(parentAbsolutePath, name);
    await fs.writeFile(targetPath, String(req.body?.contents || ''), { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') {
        throw Object.assign(new Error('File already exists.'), { statusCode: 409, code: 'file_exists' });
      }
      throw error;
    });

    res.status(201).json({ created: { type: 'file', path: path.relative(projectRoot, targetPath) } });
  });

  app.post('/api/projects/:projectId/folders', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const name = String(req.body?.name || '').trim();
    const parentAbsolutePath = resolveProjectRelativePath(projectRoot, String(req.body?.parentPath || ''));
    if (!name) {
      res.status(400).json({ error: 'invalid_name', message: 'Folder name is required.' });
      return;
    }
    if (!parentAbsolutePath) {
      res.status(400).json({ error: 'invalid_path', message: 'Parent path is invalid.' });
      return;
    }

    const targetPath = path.join(parentAbsolutePath, name);
    if (await exists(targetPath)) {
      res.status(409).json({ error: 'folder_exists', message: 'Folder already exists.' });
      return;
    }

    await fs.mkdir(targetPath, { recursive: true });
    res.status(201).json({ created: { type: 'directory', path: path.relative(projectRoot, targetPath) } });
  });

  app.post('/api/projects/:projectId/duplicate', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    try {
      res.status(201).json({
        duplicated: await duplicateItem(projectRoot, String(req.body?.path || ''), typeof req.body?.newName === 'string' ? req.body.newName : undefined),
      });
    } catch {
      res.status(400).json({ error: 'invalid_path', message: 'Path is invalid.' });
    }
  });

  app.patch('/api/projects/:projectId/rename', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const currentPath = resolveProjectRelativePath(projectRoot, String(req.body?.path || ''));
    const newName = String(req.body?.newName || '').trim();
    if (!currentPath || !newName) {
      res.status(400).json({ error: 'invalid_request', message: 'Path and newName are required.' });
      return;
    }

    const nextPath = path.join(path.dirname(currentPath), newName);
    await fs.rename(currentPath, nextPath);
    res.json({ updated: { oldPath: path.relative(projectRoot, currentPath), newPath: path.relative(projectRoot, nextPath) } });
  });

  app.delete('/api/projects/:projectId/items', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const itemPath = projectRoot ? resolveProjectRelativePath(projectRoot, String(req.body?.path || '')) : null;
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!itemPath) {
      res.status(400).json({ error: 'invalid_path', message: 'Path is invalid.' });
      return;
    }
    await fs.rm(itemPath, { recursive: Boolean(req.body?.recursive), force: false });
    res.json({ deleted: { path: path.relative(projectRoot, itemPath) } });
  });

  app.get('/api/projects/:projectId/download', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const itemPath = projectRoot ? resolveProjectRelativePath(projectRoot, String(req.query.path || '')) : null;
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!itemPath || !await exists(itemPath)) {
      res.status(404).json({ error: 'file_not_found', message: 'File not found.' });
      return;
    }
    res.download(itemPath);
  });

  app.get('/api/projects/:projectId/file', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const itemPath = projectRoot ? resolveProjectRelativePath(projectRoot, String(req.query.path || '')) : null;
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!itemPath || !await exists(itemPath)) {
      res.status(404).json({ error: 'file_not_found', message: 'File not found.' });
      return;
    }
    const stats = await fs.stat(itemPath);
    if (!stats.isFile()) {
      res.status(400).json({ error: 'not_a_file', message: 'Selected item is not a file.' });
      return;
    }
    if (stats.size > 2 * 1024 * 1024) {
      res.status(413).json({ error: 'file_too_large', message: 'File is too large to preview.' });
      return;
    }

    const buffer = await fs.readFile(itemPath);
    if (buffer.includes(0)) {
      res.json({
        content: `[binary file]\n${path.relative(projectRoot, itemPath)} cannot be displayed as text.`,
        parsed: '',
      });
      return;
    }

    const content = buffer.toString('utf-8');
    const ext = itemPath.split('.').pop()?.toLowerCase();
    const parsed = (ext === 'md' || ext === 'markdown') ? await marked(content) : '';
    res.json({ content, parsed });
  });

  app.post('/api/projects/:projectId/upload', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }

    const parentPath = resolveProjectRelativePath(projectRoot, String(req.body?.parentPath || ''));
    const name = String(req.body?.name || '').trim();
    if (!parentPath || !name) {
      res.status(400).json({ error: 'invalid_request', message: 'parentPath and name are required.' });
      return;
    }

    const targetPath = path.join(parentPath, name);
    await fs.mkdir(parentPath, { recursive: true });
    await fs.writeFile(targetPath, Buffer.from(String(req.body?.contentBase64 || ''), 'base64'));
    res.status(201).json({ uploaded: { path: path.relative(projectRoot, targetPath) } });
  });

  app.get('/api/projects/:projectId/notes', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    res.json({ content: await readProjectNotes(projectRoot) });
  });

  app.put('/api/projects/:projectId/notes', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    const content = String(req.body?.content || '');
    await writeProjectNotes(projectRoot, content);
    res.json({ content });
  });

  app.get('/api/projects/:projectId/tasks', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    res.json({ tasks: await inferTasks(projectRoot) });
  });

  app.get('/api/projects/:projectId/suggestions', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    res.json({ suggestions: await inferSuggestions(projectRoot) });
  });
}
