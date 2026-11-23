export type TransportMode = 'stdio' | 'http';
export type AuthMode = 'none' | 'bearer' | 'oauth';
export type ToolProfile = 'full' | 'gemini_only';
export type AgentDriverName = 'codex' | 'claude_code' | 'opencode';
export type MemoryCategory = 'task_state' | 'decision' | 'pitfall' | 'preference' | 'note';
export type RequiredMcpScope = 'read' | 'write';

export interface AppConfig {
  nodeEnv: string;
  transport: TransportMode;
  host: string;
  port: number;
  publicDomain: string;
  authMode: AuthMode;
  bearerToken?: string;
  oauthSigningSecret?: string;
  adminPasswordHash?: string;
  oauthAllowedRedirectHosts: string[];
  oauthStaticClientId?: string;
  oauthStaticClientSecret?: string;
  oauthAccessTokenTtlSec: number;
  oauthRefreshTokenTtlSec: number;
  oauthRefreshGraceSec: number;
  trustCfConnectingIp: boolean;
  dataDir: string;
  artifactsDir: string;
  databasePath: string;
  allowedWorkspaceRoots: string[];
  toolProfile: ToolProfile;
  trustSandboxHints: boolean;
  inlineOutputMaxBytes: number;
  defaultAgentDriver: AgentDriverName;
  agentMaxDurationSec: number;
  enableDesktopControl: boolean;
  geminiDesktopMode: 'interactive' | 'isolated';
  enableDesktopPowershell: boolean;
  ghToken?: string;
  openaiApiKey?: string;
  codexApiKey?: string;
  anthropicApiKey?: string;
}

export interface GeminiSessionRecord {
  session_id: string;
  title: string;
  model: string;
  system_instruction: string | null;
  created_at: number;
  updated_at: number;
}

export interface GeminiMessageRecord {
  id: number;
  session_id: string;
  role: 'user' | 'model';
  text_content: string;
  created_at: number;
}

export interface GeminiUsageSummary {
  total_calls: number;
  prompt_tokens: number;
  output_tokens: number;
  total_tokens: number;
  by_tool: Array<{
    tool_name: string;
    calls: number;
    total_tokens: number;
  }>;
}

export interface OAuthClientRecord {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[];
  is_static: boolean;
  created_at: number;
}

export interface OAuthAuthRequestRecord {
  auth_req_id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  resource: string;
  csrf_token: string;
  expires_at: number;
  used: boolean;
}

export interface OAuthCodeRecord {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  expires_at: number;
  used: boolean;
  token_family_id: string | null;
}

export interface OAuthTokenRecord {
  token_hash: string;
  token_type: 'access' | 'refresh';
  client_id: string;
  scope: string;
  resource: string;
  token_family_id: string;
  expires_at: number;
  grace_expires_at: number | null;
  revoked: boolean;
  created_at: number;
}

export interface OAuthAuthContext {
  clientId: string;
  scope: string;
  scopes: string[];
  resource: string;
}

export interface WorkspaceRecord {
  slug: string;
  root_path: string;
  default_branch: string;
  description: string;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceMemoryRecord {
  memory_id: string;
  workspace_slug: string;
  category: MemoryCategory;
  key: string;
  content: string;
  pinned: boolean;
  created_at: number;
  updated_at: number;
}

export interface CheckpointRecord {
  checkpoint_id: string;
  workspace_slug: string;
  git_commit_sha: string;
  git_ref: string;
  reason: string;
  created_at: number;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

export interface JobEvent {
  seq: number;
  ts: number;
  type: string;
  message: string;
}

export interface JobRecord {
  job_id: string;
  workspace_slug: string;
  runner_type: string;
  status: JobStatus;
  command_or_objective: string;
  checkpoint_id: string | null;
  events: JobEvent[];
  final_output: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ScrubberLike {
  scrub(text: string): string;
}
