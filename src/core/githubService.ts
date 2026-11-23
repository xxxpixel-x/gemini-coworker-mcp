import type { AppConfig } from '../types.js';
import { buildSandboxedEnv, runCommand } from '../utils/exec.js';
import { isSensitiveRelativePath } from './workspaceSecurity.js';

const PROTECTED_BRANCHES = new Set(['main', 'master', 'production', 'prod']);

async function runGh(
  args: string[],
  config: AppConfig,
  cwd?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await runCommand({
    command: 'gh',
    args,
    cwd,
    env: buildSandboxedEnv(process.env, {
      GH_TOKEN: config.ghToken,
    }),
    timeoutMs: 25_000,
  });
  return {
    ok: res.exitCode === 0 && !res.timedOut,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
  };
}

async function fetchGitHubApi(pathPart: string, config: AppConfig): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gemini-coworker-mcp/0.1.0',
  };
  if (config.ghToken) {
    headers.Authorization = `Bearer ${config.ghToken}`;
  }
  const res = await fetch(`https://api.github.com${pathPart}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function assertValidRepo(repo: string): string {
  const cleaned = repo.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleaned)) {
    throw new Error(`Invalid GitHub repo format "${repo}". Expected "owner/repo".`);
  }
  return cleaned;
}

export async function inspectGitHub(
  config: AppConfig,
  params: {
    mode: 'repo_info' | 'pr' | 'issue' | 'workflow_runs';
    repo: string;
    number?: number;
    limit?: number;
  },
): Promise<string> {
  const repo = assertValidRepo(params.repo);

  if (params.mode === 'repo_info') {
    const gh = await runGh(
      ['repo', 'view', repo, '--json', 'nameWithOwner,description,defaultBranchRef,url,isPrivate,updatedAt'],
      config,
    );
    if (gh.ok) return gh.stdout;
    const data = await fetchGitHubApi(`/repos/${repo}`, config);
    return JSON.stringify(data, null, 2);
  }

  if (params.mode === 'pr') {
    if (!params.number) throw new Error('number is required for mode="pr".');
    const gh = await runGh(
      [
        'pr',
        'view',
        String(params.number),
        '--repo',
        repo,
        '--json',
        'number,title,state,author,baseRefName,headRefName,body,files,statusCheckRollup,url',
      ],
      config,
    );
    if (gh.ok) return gh.stdout;
    const data = await fetchGitHubApi(`/repos/${repo}/pulls/${params.number}`, config);
    return JSON.stringify(data, null, 2);
  }

  if (params.mode === 'issue') {
    if (!params.number) throw new Error('number is required for mode="issue".');
    const gh = await runGh(
      [
        'issue',
        'view',
        String(params.number),
        '--repo',
        repo,
        '--json',
        'number,title,state,author,body,comments,labels,url',
      ],
      config,
    );
    if (gh.ok) return gh.stdout;
    const data = await fetchGitHubApi(`/repos/${repo}/issues/${params.number}`, config);
    return JSON.stringify(data, null, 2);
  }

  const limit = Math.max(1, Math.min(params.limit ?? 10, 30));
  const gh = await runGh(
    [
      'run',
      'list',
      '--repo',
      repo,
      '--limit',
      String(limit),
      '--json',
      'databaseId,displayTitle,status,conclusion,headBranch,createdAt,url',
    ],
    config,
  );
  if (gh.ok) return gh.stdout;
  const data = await fetchGitHubApi(`/repos/${repo}/actions/runs?per_page=${limit}`, config);
  return JSON.stringify(data, null, 2);
}

/**
 * Sole external write exit: enforces protected branch checks and blocks sensitive files.
 */
export async function publishExternalChanges(
  config: AppConfig,
  params: {
    action: 'git_commit_push' | 'github_pr' | 'github_comment';
    workspaceRoot?: string;
    defaultBranch?: string;
    branch?: string;
    commitMessage?: string;
    repo?: string;
    title?: string;
    body?: string;
    baseBranch?: string;
    draft?: boolean;
    issueOrPrNumber?: number;
  },
): Promise<string> {
  if (params.action === 'github_comment') {
    if (!params.repo || !params.issueOrPrNumber || !params.body?.trim()) {
      throw new Error('repo, issue_or_pr_number, and body are required for github_comment.');
    }
    const repo = assertValidRepo(params.repo);
    const gh = await runGh(
      ['issue', 'comment', String(params.issueOrPrNumber), '--repo', repo, '--body', params.body],
      config,
    );
    if (!gh.ok) {
      throw new Error(`gh issue comment failed: ${gh.stderr}`);
    }
    return gh.stdout || `Comment posted to ${repo}#${params.issueOrPrNumber}.`;
  }

  if (!params.workspaceRoot) {
    throw new Error('workspace_slug is required for git_commit_push and github_pr.');
  }

  const branchRes = await runCommand({
    command: 'git',
    args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    cwd: params.workspaceRoot,
    env: buildSandboxedEnv(),
  });
  const currentBranch = branchRes.stdout.trim();
  const targetBranch = (params.branch?.trim() || currentBranch).trim();

  if (
    !targetBranch ||
    targetBranch === 'HEAD' ||
    PROTECTED_BRANCHES.has(targetBranch.toLowerCase()) ||
    (params.defaultBranch && targetBranch === params.defaultBranch)
  ) {
    throw new Error(
      `Refusing to push directly to protected/default branch "${targetBranch}". Specify a feature branch name.`,
    );
  }

  if (params.action === 'git_commit_push' || params.commitMessage) {
    if (targetBranch !== currentBranch) {
      const checkout = await runCommand({
        command: 'git',
        args: ['checkout', '-B', targetBranch],
        cwd: params.workspaceRoot,
        env: buildSandboxedEnv(),
      });
      if (checkout.exitCode !== 0) {
        throw new Error(`git checkout -B ${targetBranch} failed: ${checkout.stderr}`);
      }
    }

    const status = await runCommand({
      command: 'git',
      args: ['status', '--porcelain'],
      cwd: params.workspaceRoot,
      env: buildSandboxedEnv(),
    });
    const dirtyFiles = status.stdout
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    for (const file of dirtyFiles) {
      if (isSensitiveRelativePath(file)) {
        throw new Error(`Refusing to stage/push sensitive file: "${file}"`);
      }
    }

    if (dirtyFiles.length > 0) {
      const msg = params.commitMessage?.trim();
      if (!msg) {
        throw new Error('Working tree has uncommitted changes; commit_message is required.');
      }
      const addRes = await runCommand({
        command: 'git',
        args: ['add', '-A'],
        cwd: params.workspaceRoot,
        env: buildSandboxedEnv(),
      });
      if (addRes.exitCode !== 0) throw new Error(`git add failed: ${addRes.stderr}`);

      const commitRes = await runCommand({
        command: 'git',
        args: ['commit', '-m', msg],
        cwd: params.workspaceRoot,
        env: buildSandboxedEnv(),
      });
      if (commitRes.exitCode !== 0) {
        throw new Error(`git commit failed: ${commitRes.stderr || commitRes.stdout}`);
      }
    }

    const pushRes = await runCommand({
      command: 'git',
      args: ['push', '-u', 'origin', targetBranch],
      cwd: params.workspaceRoot,
      env: buildSandboxedEnv(process.env, { GH_TOKEN: config.ghToken }),
      timeoutMs: 30_000,
    });
    if (pushRes.exitCode !== 0) {
      throw new Error(`git push failed: ${pushRes.stderr || pushRes.stdout}`);
    }

    if (params.action === 'git_commit_push') {
      return `Committed and pushed branch "${targetBranch}" to origin.\n${pushRes.stdout || pushRes.stderr}`;
    }
  }

  // github_pr
  if (!params.title?.trim()) {
    throw new Error('title is required for github_pr.');
  }
  const prArgs = [
    'pr',
    'create',
    '--title',
    params.title.trim(),
    '--body',
    params.body?.trim() || 'Created via Gemini Coworker.',
    '--head',
    targetBranch,
  ];
  if (params.baseBranch?.trim()) prArgs.push('--base', params.baseBranch.trim());
  if (params.repo?.trim()) prArgs.push('--repo', assertValidRepo(params.repo));
  if (params.draft !== false) prArgs.push('--draft');

  const prRes = await runGh(prArgs, config, params.workspaceRoot);
  if (!prRes.ok) {
    throw new Error(`gh pr create failed: ${prRes.stderr || prRes.stdout}`);
  }
  return `Pull request created:\n${prRes.stdout}`;
}
