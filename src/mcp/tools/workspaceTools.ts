import { z } from 'zod';
import { generateId } from '../../auth/crypto.js';
import {
  applyWorkspacePatch,
  getGitStatusOrDiff,
  listWorkspaceTree,
  readOffloadedArtifact,
  readWorkspaceFileLines,
  searchWorkspaceCode,
} from '../../core/codeTools.js';
import {
  createGitCheckpoint,
  detectDefaultBranch,
  rollbackToCheckpoint,
} from '../../core/gitSnapshot.js';
import {
  assertAllowedWorkspaceRoot,
  assertValidSlug,
} from '../../core/workspaceSecurity.js';
import type { MemoryCategory } from '../../types.js';
import type { McpToolRegistry } from '../registry.js';
import { requireWorkspace, type McpToolContext } from './context.js';

const memoryCategoryEnum = z.enum(['task_state', 'decision', 'pitfall', 'preference', 'note']);

export function registerWorkspaceTools(registry: McpToolRegistry, ctx: McpToolContext): void {
  const baseGuard = (label: string) => ({
    scrubber: ctx.scrubber,
    artifactsDir: ctx.config.artifactsDir,
    maxBytes: ctx.config.inlineOutputMaxBytes,
    label,
  });

  // Tool #1: workspace_manage
  registry.register({
    name: 'workspace_manage',
    title: 'Workspace, Checkpoint & Memory Manager',
    description:
      'Manage registered local project workspaces, non-destructive Git checkpoints/rollbacks, and cross-session persistent memories.',
    inputSchema: {
      action: z
        .enum([
          'list',
          'register',
          'unregister',
          'checkpoint',
          'list_checkpoints',
          'rollback',
          'memory_list',
          'memory_upsert',
          'memory_delete',
        ])
        .describe('Operation to perform'),
      slug: z.string().optional().describe('Workspace slug (lowercase alphanumeric, -, _)'),
      path: z.string().optional().describe('Absolute local directory path (for action="register")'),
      description: z.string().optional().describe('Optional workspace description'),
      checkpoint_id: z.string().optional().describe('Checkpoint ID (for action="rollback")'),
      reason: z.string().optional().describe('Checkpoint reason (for action="checkpoint")'),
      memory_category: memoryCategoryEnum.optional(),
      memory_key: z.string().optional(),
      memory_content: z.string().optional(),
      pinned: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    requiredScope: (args) =>
      ['list', 'list_checkpoints', 'memory_list'].includes(args.action) ? 'read' : 'write',
    guard: baseGuard('workspace_manage'),
    handler: async (args) => {
      switch (args.action) {
        case 'list': {
          const workspaces = ctx.store.listWorkspaces();
          const summary = workspaces.map((ws) => ({
            ...ws,
            memory_count: ctx.store.listMemories(ws.slug, undefined, 100).length,
            recent_memories: ctx.store
              .listMemories(ws.slug, undefined, 5)
              .map((m) => ({ category: m.category, key: m.key, pinned: m.pinned, content: m.content })),
          }));
          return JSON.stringify(
            {
              allowed_workspace_roots: ctx.config.allowedWorkspaceRoots,
              workspaces: summary,
            },
            null,
            2,
          );
        }

        case 'register': {
          if (!args.slug || !args.path) {
            throw new Error('slug and path are required for action="register".');
          }
          const slug = assertValidSlug(args.slug);
          const safeRoot = assertAllowedWorkspaceRoot(
            args.path,
            ctx.config.allowedWorkspaceRoots,
            ctx.config.dataDir,
          );
          const defaultBranch = await detectDefaultBranch(safeRoot);
          const ws = ctx.store.upsertWorkspace({
            slug,
            root_path: safeRoot,
            default_branch: defaultBranch,
            description: args.description?.trim() ?? '',
          });
          ctx.store.recordAudit({
            actor: 'mcp',
            action: 'workspace_register',
            target: slug,
            status: 'success',
            details: { root_path: safeRoot },
          });
          return JSON.stringify({ registered: ws }, null, 2);
        }

        case 'unregister': {
          if (!args.slug) throw new Error('slug is required for action="unregister".');
          const deleted = ctx.store.deleteWorkspace(args.slug);
          return JSON.stringify({ slug: args.slug, unregistered: deleted }, null, 2);
        }

        case 'checkpoint': {
          if (!args.slug) throw new Error('slug is required for action="checkpoint".');
          const ws = requireWorkspace(ctx, args.slug);
          const cp = await ctx.locks.runExclusive(ws.slug, () =>
            createGitCheckpoint(
              ctx.store,
              ws.slug,
              ws.root_path,
              args.reason?.trim() || 'manual-checkpoint',
            ),
          );
          if (!cp) {
            return `Workspace "${ws.slug}" is not a Git repository; no checkpoint created.`;
          }
          return JSON.stringify({ checkpoint: cp }, null, 2);
        }

        case 'list_checkpoints': {
          if (!args.slug) throw new Error('slug is required for action="list_checkpoints".');
          requireWorkspace(ctx, args.slug);
          const list = ctx.store.listCheckpoints(args.slug, args.limit ?? 20);
          return JSON.stringify({ checkpoints: list }, null, 2);
        }

        case 'rollback': {
          if (!args.slug || !args.checkpoint_id) {
            throw new Error('slug and checkpoint_id are required for action="rollback".');
          }
          const ws = requireWorkspace(ctx, args.slug);
          const result = await ctx.locks.runExclusive(ws.slug, () =>
            rollbackToCheckpoint(ctx.store, ws.slug, ws.root_path, args.checkpoint_id!),
          );
          return JSON.stringify({ rolled_back: true, ...result }, null, 2);
        }

        case 'memory_list': {
          if (!args.slug) throw new Error('slug is required for action="memory_list".');
          requireWorkspace(ctx, args.slug);
          const memories = ctx.store.listMemories(
            args.slug,
            args.memory_category as MemoryCategory | undefined,
            args.limit ?? 50,
          );
          return JSON.stringify({ memories }, null, 2);
        }

        case 'memory_upsert': {
          if (!args.slug || !args.memory_category || !args.memory_key || !args.memory_content) {
            throw new Error(
              'slug, memory_category, memory_key, and memory_content are required for action="memory_upsert".',
            );
          }
          requireWorkspace(ctx, args.slug);
          if (Buffer.byteLength(args.memory_content, 'utf8') > 8192) {
            throw new Error('memory_content exceeds 8KB limit.');
          }
          if (ctx.scrubber.containsLikelySecret(args.memory_content)) {
            throw new Error('Refusing to store likely secret in workspace memory.');
          }
          const saved = ctx.store.upsertMemory({
            memory_id: generateId('mem', 8),
            workspace_slug: args.slug,
            category: args.memory_category,
            key: args.memory_key.trim().slice(0, 120),
            content: args.memory_content,
            pinned: args.pinned ?? false,
          });
          return JSON.stringify({ memory: saved }, null, 2);
        }

        case 'memory_delete': {
          if (!args.slug || !args.memory_category || !args.memory_key) {
            throw new Error(
              'slug, memory_category, and memory_key are required for action="memory_delete".',
            );
          }
          const deleted = ctx.store.deleteMemory(args.slug, args.memory_category, args.memory_key);
          return JSON.stringify({ deleted }, null, 2);
        }
      }
    },
  });

  // Tool #2: code_explore
  registry.register({
    name: 'code_explore',
    title: 'Code Explorer & Artifact Reader',
    description:
      'Read-only workspace exploration: directory tree, fast text/regex search (ripgrep or Node fallback), line-bounded file reading, git status/diff, and reading offloaded artifacts.',
    inputSchema: {
      mode: z.enum(['tree', 'search', 'read_lines', 'git_status', 'git_diff', 'read_artifact']),
      workspace_slug: z.string().optional().describe('Registered workspace slug (not needed for read_artifact)'),
      path: z.string().optional().describe('Relative file or directory path'),
      query: z.string().optional().describe('Search query (for mode="search")'),
      regex: z.boolean().optional().describe('Treat query as regular expression'),
      max_depth: z.number().int().min(1).max(8).optional(),
      max_results: z.number().int().min(1).max(300).optional(),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
      staged: z.boolean().optional(),
      base_ref: z.string().optional(),
      artifact_id: z.string().optional().describe('Artifact ID (for mode="read_artifact")'),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50000).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    requiredScope: 'read',
    guard: baseGuard('code_explore'),
    handler: async (args) => {
      if (args.mode === 'read_artifact') {
        if (!args.artifact_id) throw new Error('artifact_id is required for mode="read_artifact".');
        return readOffloadedArtifact(
          ctx.config.artifactsDir,
          args.artifact_id,
          args.offset ?? 0,
          args.limit ?? 20_000,
        );
      }

      if (!args.workspace_slug) {
        throw new Error(`workspace_slug is required for mode="${args.mode}".`);
      }
      const ws = requireWorkspace(ctx, args.workspace_slug);

      switch (args.mode) {
        case 'tree':
          return listWorkspaceTree(ws.root_path, args.path ?? '.', args.max_depth ?? 3);
        case 'search':
          if (!args.query) throw new Error('query is required for mode="search".');
          return searchWorkspaceCode(ws.root_path, args.query, {
            subPath: args.path,
            regex: args.regex,
            maxResults: args.max_results,
          });
        case 'read_lines':
          if (!args.path) throw new Error('path is required for mode="read_lines".');
          return readWorkspaceFileLines(
            ws.root_path,
            args.path,
            args.start_line ?? 1,
            args.end_line ?? 200,
          );
        case 'git_status':
          return getGitStatusOrDiff(ws.root_path, 'git_status');
        case 'git_diff':
          return getGitStatusOrDiff(ws.root_path, 'git_diff', {
            staged: args.staged,
            baseRef: args.base_ref,
          });
      }
    },
  });

  // Tool #3: code_patch
  registry.register({
    name: 'code_patch',
    title: 'Atomic Code Patcher with Git Checkpoints',
    description:
      'Apply atomic multi-file search/replace hunks, create/overwrite files, or delete files inside a workspace with automatic pre-write Git checkpointing, secret detection, and rollback on validation failure.',
    inputSchema: {
      workspace_slug: z.string().min(1),
      action: z.enum(['patch', 'create_or_overwrite', 'delete_file']),
      edits: z
        .array(
          z.object({
            path: z.string().min(1),
            hunks: z
              .array(
                z.object({
                  search: z.string().min(1),
                  replace: z.string(),
                  line_hint: z.number().int().min(1).optional(),
                }),
              )
              .min(1),
          }),
        )
        .optional()
        .describe('Multi-file edits (for action="patch")'),
      path: z.string().optional().describe('Relative path (for create_or_overwrite / delete_file)'),
      content: z.string().optional().describe('File content (for create_or_overwrite)'),
      rollback_on_failure: z.boolean().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    requiredScope: 'write',
    guard: baseGuard('code_patch'),
    handler: async (args) => {
      const ws = requireWorkspace(ctx, args.workspace_slug);
      const result = await ctx.locks.runExclusive(ws.slug, () =>
        applyWorkspacePatch({
          store: ctx.store,
          scrubber: ctx.scrubber,
          workspaceSlug: ws.slug,
          workspaceRoot: ws.root_path,
          action: args.action,
          edits: args.edits,
          filePath: args.path,
          content: args.content,
          rollbackOnFailure: args.rollback_on_failure,
        }),
      );
      return JSON.stringify(result, null, 2);
    },
  });
}
