import path from 'node:path';
import type { Express } from 'express';
import {
  createGitHttpEnv,
  clearSavedGitAuth,
  ensureGitRepo,
  getGitBranches,
  getGitStatus,
  initializeGitRepository,
  runGit,
  saveGitAuth,
  readSavedGitAuth,
} from './git';
import {
  ensureProjectsRoot,
  exists,
  getProjectsRoot,
  readStringParam,
  requireAuth,
  resolveProjectRoot,
  resolveWorkspace,
  validateProjectName,
} from './runtime';

function notGitRepo(res: Parameters<Express['get']>[1] extends never ? never : any): void {
  res.status(400).json({
    error: 'not_a_git_repo',
    message: 'Git repository not detected for this project. Project setup may not have initialized Git successfully.',
  });
}

export function registerGitRoutes(app: Express): void {
  app.get('/api/git/auth', requireAuth, async (_req, res) => {
    const workspace = resolveWorkspace();
    const auth = await readSavedGitAuth(workspace);
    res.json({
      saved: Boolean(auth?.token || auth?.password),
      username: auth?.username ?? '',
      updatedAt: auth?.updatedAt ?? null,
    });
  });

  app.post('/api/git/auth', requireAuth, async (req, res) => {
    const workspace = resolveWorkspace();
    const auth = req.body?.auth ?? req.body ?? {};
    const saved = await saveGitAuth(workspace, {
      username: String(auth?.username || ''),
      token: String(auth?.token || ''),
      password: String(auth?.password || ''),
    });
    res.json({
      ok: true,
      saved: Boolean(saved?.token || saved?.password),
      username: saved?.username ?? '',
      updatedAt: saved?.updatedAt ?? null,
    });
  });

  app.delete('/api/git/auth', requireAuth, async (_req, res) => {
    const workspace = resolveWorkspace();
    await clearSavedGitAuth(workspace);
    res.json({ ok: true, saved: false });
  });

  app.post('/api/projects/clone', requireAuth, async (req, res) => {
    const url = String(req.body?.url || '').trim();
    const requestedName = String(req.body?.name || '').trim();
    const branch = String(req.body?.branch || '').trim();
    const provider = String(req.body?.provider || 'url');

    if (!url) {
      res.status(400).json({ error: 'invalid_request', message: 'url is required.' });
      return;
    }
    if (provider !== 'url') {
      res.status(400).json({ error: 'unsupported_provider', message: 'Only provider=url is currently supported.' });
      return;
    }

    const projectName = validateProjectName(requestedName || path.basename(url, '.git'));
    if (!projectName) {
      res.status(400).json({
        error: 'invalid_project_name',
        message: 'Project names may only contain letters, numbers, hyphens, underscores, and periods.',
      });
      return;
    }

    await ensureProjectsRoot();
    const projectPath = path.join(getProjectsRoot(), projectName);
    if (await exists(projectPath)) {
      res.status(409).json({ error: 'project_exists', message: 'A project with this name already exists.' });
      return;
    }

    const args = ['clone'];
    if (branch) {
      args.push('--branch', branch);
    }
    args.push(url, projectPath);

    try {
      if (req.body?.auth && (String(req.body.auth.token || '').trim() || String(req.body.auth.password || '').trim())) {
        const workspace = resolveWorkspace();
        await saveGitAuth(workspace, req.body.auth);
      }
      const workspace = resolveWorkspace();
      await runGit(process.cwd(), args, await createGitHttpEnv(workspace, req.body?.auth));
      res.status(201).json({ project: { id: projectName, name: projectName, path: projectPath } });
    } catch (error) {
      res.status(400).json({ error: 'git_clone_failed', message: error instanceof Error ? error.message : 'Clone failed.' });
    }
  });

  app.post('/api/projects/:projectId/git/init', requireAuth, async (req, res) => {
    const projectId = readStringParam(req.params.projectId);
    const projectRoot = resolveProjectRoot(projectId);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    try {
      await initializeGitRepository(projectRoot);
      res.status(200).json({
        ok: true,
        project: { id: projectId, path: projectRoot, gitInitialized: true },
        git: await getGitStatus(projectRoot),
      });
    } catch (error) {
      res.status(500).json({ error: 'git_init_failed', message: error instanceof Error ? error.message : 'Git initialization failed.' });
    }
  });

  app.get('/api/projects/:projectId/git/status', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!await ensureGitRepo(projectRoot)) {
      notGitRepo(res);
      return;
    }
    res.json(await getGitStatus(projectRoot));
  });

  app.get('/api/projects/:projectId/git/diff', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!await ensureGitRepo(projectRoot)) {
      notGitRepo(res);
      return;
    }
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (filePath) {
      try {
        const status = await getGitStatus(projectRoot);
        const isUntracked = status.untracked.some((item) => item.path === filePath);
        if (isUntracked) {
          try {
            const output = await runGit(projectRoot, ['diff', '--no-index', '--', '/dev/null', filePath]);
            res.json({ diff: output.stdout || output.stderr || '' });
            return;
          } catch (error) {
            const diffOutput = error instanceof Error && 'stdout' in error ? String((error as { stdout?: string }).stdout || '') : '';
            res.json({ diff: diffOutput });
            return;
          }
        }
      } catch {
        // Fall back to the regular diff path below.
      }
    }
    const args = ['diff'];
    if (String(req.query.staged || 'false') === 'true') {
      args.push('--cached');
    }
    if (filePath) {
      args.push('--', filePath);
    }
    res.json({ diff: (await runGit(projectRoot, args)).stdout });
  });

  app.get('/api/projects/:projectId/git/log', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!await ensureGitRepo(projectRoot)) {
      notGitRepo(res);
      return;
    }
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const filePath = typeof req.query.path === 'string' ? req.query.path : undefined;
    const args = ['log', `--max-count=${limit}`, '--format=%H|%h|%s|%an|%ae|%ad|%ar'];
    if (filePath) {
      args.push('--', filePath);
    }
    const output = (await runGit(projectRoot, args)).stdout;
    const commits = output.trim().split('\n').filter(Boolean).map((line) => {
      const [hash, shortHash, subject, authorName, authorEmail, date, relativeDate] = line.split('|');
      return { hash, shortHash, subject, authorName, authorEmail, date, relativeDate };
    });
    res.json({ commits });
  });

  app.get('/api/projects/:projectId/git/show', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!await ensureGitRepo(projectRoot)) {
      notGitRepo(res);
      return;
    }
    const hash = String(req.query.hash || 'HEAD');
    const filePath = typeof req.query.path === 'string' ? req.query.path : undefined;
    const args = ['show', `${hash}${filePath ? ` -- ${filePath}` : ''}`];
    try {
      const output = (await runGit(projectRoot, args)).stdout;
      res.json({ hash, content: output });
    } catch {
      res.json({ hash, content: '' });
    }
  });

  app.get('/api/projects/:projectId/git/branches', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!await ensureGitRepo(projectRoot)) {
      notGitRepo(res);
      return;
    }
    res.json(await getGitBranches(projectRoot));
  });

  app.post('/api/projects/:projectId/git/stage', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter((value: unknown): value is string => typeof value === 'string') : [];
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!await ensureGitRepo(projectRoot)) {
      notGitRepo(res);
      return;
    }
    await runGit(projectRoot, ['add', '--', ...paths]);
    res.json({ ok: true });
  });

  app.post('/api/projects/:projectId/git/unstage', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter((value: unknown): value is string => typeof value === 'string') : [];
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!await ensureGitRepo(projectRoot)) {
      notGitRepo(res);
      return;
    }
    await runGit(projectRoot, ['restore', '--staged', '--', ...paths]);
    res.json({ ok: true });
  });

  app.post('/api/projects/:projectId/git/discard', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter((value: unknown): value is string => typeof value === 'string') : [];
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!await ensureGitRepo(projectRoot)) {
      notGitRepo(res);
      return;
    }
    await runGit(projectRoot, ['restore', '--', ...paths]);
    res.json({ ok: true });
  });

  app.post('/api/projects/:projectId/git/commit', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const message = String(req.body?.message || '').trim();
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!await ensureGitRepo(projectRoot)) {
      notGitRepo(res);
      return;
    }
    if (!message) {
      res.status(400).json({ error: 'invalid_commit_message', message: 'Commit message is required.' });
      return;
    }
    try {
      await runGit(projectRoot, ['commit', '-m', message]);
      res.json({ ok: true, commit: { message, hash: (await runGit(projectRoot, ['rev-parse', '--short', 'HEAD'])).stdout.trim() } });
    } catch (error) {
      res.status(400).json({ error: 'git_commit_failed', message: error instanceof Error ? error.message : 'Commit failed.' });
    }
  });

  app.post('/api/projects/:projectId/git/branch/checkout', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    const branch = String(req.body?.branch || '').trim();
    const create = Boolean(req.body?.create);
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!await ensureGitRepo(projectRoot)) {
      notGitRepo(res);
      return;
    }
    if (!branch) {
      res.status(400).json({ error: 'invalid_branch', message: 'Branch is required.' });
      return;
    }
    try {
      await runGit(projectRoot, create ? ['checkout', '-b', branch] : ['checkout', branch]);
      res.json({ ok: true, branch });
    } catch (error) {
      res.status(400).json({ error: 'git_checkout_failed', message: error instanceof Error ? error.message : 'Checkout failed.' });
    }
  });

  app.post('/api/projects/:projectId/git/pull', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!await ensureGitRepo(projectRoot)) {
      notGitRepo(res);
      return;
    }
    try {
      if (req.body?.auth && (String(req.body.auth.token || '').trim() || String(req.body.auth.password || '').trim())) {
        const workspace = resolveWorkspace();
        await saveGitAuth(workspace, req.body.auth);
      }
      const workspace = resolveWorkspace();
      const result = await runGit(projectRoot, ['pull', '--ff-only'], await createGitHttpEnv(workspace, req.body?.auth));
      res.json({ ok: true, output: `${result.stdout}${result.stderr}`.trim() });
    } catch (error) {
      res.status(400).json({ error: 'git_pull_failed', message: error instanceof Error ? error.message : 'Pull failed.' });
    }
  });

  app.post('/api/projects/:projectId/git/push', requireAuth, async (req, res) => {
    const projectRoot = resolveProjectRoot(readStringParam(req.params.projectId));
    if (!projectRoot || !await exists(projectRoot)) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
      return;
    }
    if (!await ensureGitRepo(projectRoot)) {
      res.status(400).json({ error: 'not_a_git_repo', message: 'This project is not a git repository.' });
      return;
    }
    try {
      if (req.body?.auth && (String(req.body.auth.token || '').trim() || String(req.body.auth.password || '').trim())) {
        const workspace = resolveWorkspace();
        await saveGitAuth(workspace, req.body.auth);
      }
      const workspace = resolveWorkspace();
      const result = await runGit(projectRoot, ['push'], await createGitHttpEnv(workspace, req.body?.auth));
      res.json({ ok: true, output: `${result.stdout}${result.stderr}`.trim() });
    } catch (error) {
      res.status(400).json({ error: 'git_push_failed', message: error instanceof Error ? error.message : 'Push failed.' });
    }
  });
}
