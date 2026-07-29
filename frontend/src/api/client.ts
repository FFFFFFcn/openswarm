import type { AccountExtractResult, AccountProfile, AccountProfileInput, AgentTeamConfig, Artifact, ComposerImage, ReportEnvelope, TeamPointer, ToolCallBlock } from "./types";

const USER_ID = "local-user";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-User-ID": USER_ID,
      ...options.headers,
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { detail: text };
  }
  if (!response.ok) {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    throw new ApiError(String(record.detail ?? record.message ?? `请求失败 (${response.status})`), response.status);
  }
  return body as T;
}

const data = async <T>(path: string, options?: RequestInit) => (await request<{ data: T }>(path, options)).data;

export const operationsApi = {
  teamConfig: () => data<AgentTeamConfig>("/api/v1/agent-team/config"),
};

/** Account library CRUD plus the screenshot extraction endpoint. */
export const accountsApi = {
  list: () => data<AccountProfile[]>("/api/v1/account-profiles"),
  create: (payload: AccountProfileInput) => data<AccountProfile>("/api/v1/account-profiles", { method: "POST", body: JSON.stringify(payload) }),
  update: (id: string, payload: AccountProfileInput) => data<AccountProfile>(`/api/v1/account-profiles/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) }),
  remove: (id: string) => request<null>(`/api/v1/account-profiles/${encodeURIComponent(id)}`, { method: "DELETE" }),
  extract: (payload: { image_base64: string; mime_type: string; model: string; credential_id: string }) =>
    data<AccountExtractResult>("/api/v1/account-profiles/extract", { method: "POST", body: JSON.stringify(payload) }),
};

export const artifactsApi = {
  list: () => data<Artifact[]>("/api/v1/artifacts"),
  data: (id: string) => data<ReportEnvelope>(`/api/v1/artifacts/${encodeURIComponent(id)}/data`),
  batchDelete: (ids: string[]) => data<{ deleted: string[] }>("/api/v1/artifacts/batch-delete", { method: "POST", body: JSON.stringify({ ids }) }),
};

export interface AdminOverview {
  storage: {
    database_size: number;
    reports_files: number;
    reports_size: number;
    workspaces_count: number;
    workspaces_size: number;
    logs: Record<string, number>;
  };
  counts: Record<string, number>;
}

export interface AdminWorkspace {
  id: string;
  files: number;
  size: number;
  updated_at: number;
}

export interface AdminCredential {
  id: string;
  name: string | null;
  type: string | null;
  base_url: string | null;
  api_key_masked: string;
  created_at: string;
}

export interface AdminRedFoxKey {
  configured: boolean;
  source: "stored" | "env" | null;
  api_key_masked: string;
}

export interface AdminRecord {
  id: string;
  title?: string;
  positioning?: string;
  status: string;
  score?: number;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface AdminAgent {
  id: string;
  name: string;
  source: "user" | "team";
  role: string | null;
  sessions: number;
  system_prompt: string;
  created_at: string;
}

export interface AdminTeam {
  id: string;
  name: string;
  description: string;
  members: number;
  created_at: string;
}

export interface AdminAgentTeam {
  runtime: { redis_mode: string; available: boolean };
  agents: AdminAgent[];
  teams: AdminTeam[];
}

export interface AdminRoleTool {
  name: string;
  description: string;
  read_only: boolean;
  kind: "local" | "external_data" | "user_interaction";
}

export interface AdminAgentRole {
  key: string;
  label: string;
  kind: "leader" | "worker";
  description: string;
  system_prompt: string;
  skill: string;
  skill_path: string;
  tools: AdminRoleTool[];
  builtin_note: string;
}

export const adminApi = {
  overview: () => data<AdminOverview>("/api/v1/admin/overview"),
  logs: (name: "backend" | "error", tail: number) => data<{ name: string; size: number; lines: string[] }>(`/api/v1/admin/logs?name=${name}&tail=${tail}`),
  workspaces: () => data<AdminWorkspace[]>("/api/v1/admin/workspaces"),
  workspacesDelete: (ids: string[]) => data<{ deleted: string[]; skipped: string[] }>("/api/v1/admin/workspaces/batch-delete", { method: "POST", body: JSON.stringify({ ids }) }),
  credentials: () => data<AdminCredential[]>("/api/v1/admin/credentials"),
  credentialDelete: (id: string) => data<{ deleted: string; note: string }>(`/api/v1/admin/credentials/${encodeURIComponent(id)}`, { method: "DELETE" }),
  redfoxKey: () => data<AdminRedFoxKey>("/api/v1/admin/redfox-key"),
  redfoxKeyUpdate: (apiKey: string) => data<AdminRedFoxKey>("/api/v1/admin/redfox-key", { method: "PUT", body: JSON.stringify({ api_key: apiKey }) }),
  redfoxKeyDelete: () => data<AdminRedFoxKey>("/api/v1/admin/redfox-key", { method: "DELETE" }),
  topicDelete: (id: string) => data<{ deleted: string }>(`/api/v1/admin/topics/${encodeURIComponent(id)}`, { method: "DELETE" }),
  draftDelete: (id: string) => data<{ deleted: string }>(`/api/v1/admin/drafts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  strategyDelete: (id: string) => data<{ deleted: string }>(`/api/v1/admin/strategies/${encodeURIComponent(id)}`, { method: "DELETE" }),
  topics: (accountId?: string) => data<AdminRecord[]>(`/api/v1/topics?limit=100${accountId ? `&account_id=${encodeURIComponent(accountId)}` : ""}`),
  drafts: (accountId?: string) => data<AdminRecord[]>(`/api/v1/drafts?limit=100${accountId ? `&account_id=${encodeURIComponent(accountId)}` : ""}`),
  strategies: (accountId?: string) => data<AdminRecord[]>(`/api/v1/strategies?limit=100${accountId ? `&account_id=${encodeURIComponent(accountId)}` : ""}`),
  accounts: () => data<AdminRecord[]>("/api/v1/account-profiles"),
  topicPatch: (id: string, changes: Record<string, unknown>) => data<AdminRecord>(`/api/v1/topics/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) }),
  draftPatch: (id: string, changes: Record<string, unknown>) => data<AdminRecord>(`/api/v1/drafts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) }),
  strategyPatch: (id: string, changes: Record<string, unknown>) => data<AdminRecord>(`/api/v1/strategies/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) }),
  agentTeam: () => data<AdminAgentTeam>("/api/v1/admin/agent-team"),
  agentTeamRoles: () => data<AdminAgentRole[]>("/api/v1/admin/agent-team/roles"),
  agentDelete: (id: string) => request<null>(`/agent/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export const agentApi = {
  // max_iters lifts the ReAct loop cap (framework default 20) — the leader
  // orchestrates the whole team in one reply, so it gets extra headroom.
  createLeader: (name: string, systemPrompt: string) => request<{ agent_id: string }>("/agent/", { method: "POST", body: JSON.stringify({ name, system_prompt: systemPrompt, react_config: { max_iters: 40 } }) }),
  createSession: (agentId: string, model: { model_type: string; credential_id: string; model: string }) => request<{ session_id: string }>("/sessions/", { method: "POST", body: JSON.stringify({ agent_id: agentId, chat_model_config: { type: model.model_type, credential_id: model.credential_id, model: model.model, parameters: {} } }) }),
  send: (team: TeamPointer, text: string, images: ComposerImage[] = []) => {
    const content: Array<Record<string, unknown>> = [];
    if (text) content.push({ type: "text", text });
    for (const image of images) content.push({ type: "data", source: { type: "base64", data: image.data, media_type: image.mediaType } });
    return request("/chat/", { method: "POST", body: JSON.stringify({ agent_id: team.agent_id, session_id: team.session_id, input: { name: "user", role: "user", content } }) });
  },
  /** Resume an interrupted/parked run from its persisted state (input: null). */
  continueRun: (team: TeamPointer) => request("/chat/", { method: "POST", body: JSON.stringify({ agent_id: team.agent_id, session_id: team.session_id, input: null }) }),
  interrupt: (agentId: string, sessionId: string) => request(`/sessions/${encodeURIComponent(sessionId)}/interrupt?agent_id=${encodeURIComponent(agentId)}`, { method: "POST" }),
  confirm: (team: TeamPointer, replyId: string, confirmResults: Array<{ confirmed: boolean; tool_call: ToolCallBlock }>) => request("/chat/", { method: "POST", body: JSON.stringify({ agent_id: team.agent_id, session_id: team.session_id, input: { type: "USER_CONFIRM_RESULT", reply_id: replyId, confirm_results: confirmResults } }) }),
  /** Return the user's answer for an external tool call (ask_user) and resume the run. */
  externalResult: (team: TeamPointer, replyId: string, results: Array<{ id: string; name: string; output: string }>) =>
    request("/chat/", { method: "POST", body: JSON.stringify({ agent_id: team.agent_id, session_id: team.session_id, input: { type: "EXTERNAL_EXECUTION_RESULT", reply_id: replyId, execution_results: results.map((r) => ({ type: "tool_result", id: r.id, name: r.name, output: [{ type: "text", text: r.output }] })) } }) }),
  /** Push a steering hint into running sessions' inboxes (mid-run user message). */
  steer: (targets: Array<{ agent_id: string; session_id: string }>, text: string, images: ComposerImage[] = []) =>
    data<{ delivered: number }>("/api/v1/agent-team/steer", { method: "POST", body: JSON.stringify({ targets, text, images: images.map((i) => ({ data: i.data, media_type: i.mediaType })) }) }),
  /** PATCH session settings (e.g. attach knowledge bases). */
  patchSession: (team: TeamPointer, changes: Record<string, unknown>) =>
    request(`/sessions/${encodeURIComponent(team.session_id)}?agent_id=${encodeURIComponent(team.agent_id)}`, { method: "PATCH", body: JSON.stringify(changes) }),
};

/* ---- Knowledge base (RAG attachments) ---- */

export interface EmbeddingProviderOption {
  credentialId: string;
  type: string;
  model: string;
  dimensions: number;
}

export interface KbDocumentStatus {
  id: string;
  filename: string;
  status: string;
  error?: string | null;
}

export const kbApi = {
  /** Pick the first available embedding provider+model, or null when none is configured. */
  firstEmbeddingOption: async (): Promise<EmbeddingProviderOption | null> => {
    const body = await request<{ providers?: Array<{ credential?: { id?: string; data?: Record<string, unknown> }; models?: Array<{ name?: string; dimensions?: number }> }> }>("/knowledge_bases/embedding_models");
    for (const provider of body.providers ?? []) {
      const credentialId = provider.credential?.id;
      const type = provider.credential?.data?.type;
      const model = provider.models?.[0];
      if (credentialId && typeof type === "string" && model?.name && typeof model.dimensions === "number") {
        return { credentialId, type, model: model.name, dimensions: model.dimensions };
      }
    }
    return null;
  },
  create: (name: string, option: EmbeddingProviderOption) =>
    request<{ knowledge_base_id: string }>("/knowledge_bases/", { method: "POST", body: JSON.stringify({ name, description: "会话附件知识库", embedding_model_config: { type: option.type, credential_id: option.credentialId, model: option.model, dimensions: option.dimensions, parameters: {} } }) }),
  /** Multipart upload — plain fetch so the browser sets the boundary header itself. */
  uploadDocument: async (kbId: string, file: File): Promise<{ document_id: string; filename: string; status: string }> => {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`/knowledge_bases/${encodeURIComponent(kbId)}/documents`, { method: "POST", headers: { "X-User-ID": USER_ID }, body: form });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new ApiError(String(body.detail ?? `上传失败 (${response.status})`), response.status);
    return body as unknown as { document_id: string; filename: string; status: string };
  },
  documentsStatus: (kbId: string, ids: string[]) =>
    request<{ items: KbDocumentStatus[] }>(`/knowledge_bases/${encodeURIComponent(kbId)}/documents/status?ids=${ids.map(encodeURIComponent).join(",")}`),
};

/* ---- Scheduled tasks ---- */

export interface ScheduleRecord {
  id: string;
  name: string;
  description: string;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
  [key: string]: unknown;
}

export const scheduleApi = {
  list: async (): Promise<ScheduleRecord[]> => (await request<{ schedules?: ScheduleRecord[] }>("/schedule/")).schedules ?? [],
  create: (payload: { name: string; description: string; cron_expression: string; timezone: string; agent_id: string; chat_model_config: Record<string, unknown> }) =>
    request<{ schedule_id: string }>("/schedule/", { method: "POST", body: JSON.stringify({ ...payload, enabled: true, stateful: false, permission_mode: "auto_allow" }) }),
  remove: (id: string) => request<null>(`/schedule/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export function formatDate(value?: string): string {
  return value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "";
}
