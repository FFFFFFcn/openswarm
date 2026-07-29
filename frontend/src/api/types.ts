export type PageKey = "team" | "accounts" | "assets" | "settings" | "admin";

/** Metadata for one chat conversation shown in the sidebar history list. */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  /** Backend team (leader agent + session) owned by this conversation. */
  team?: TeamPointer;
  /** Knowledge base attached to this conversation (RAG attachments). */
  kb?: { id: string };
  /** Account bound to this conversation (agent tasks target this account). */
  account?: { id: string; name: string };
}

/** One Xiaohongshu account in the user's account library. */
export interface AccountProfile {
  id: string;
  account_name: string;
  niche: string;
  target_audience: string;
  primary_goal: string;
  voice: string;
  differentiators: string[];
  forbidden_topics: string[];
  red_id: string;
  follower_count: number | null;
  notes_count: number | null;
  intro: string;
  profile_url: string;
  source: "manual" | "screenshot";
  created_at: string;
  updated_at: string;
}

/** Editable payload for creating / updating an account profile. */
export interface AccountProfileInput {
  account_name: string;
  niche: string;
  target_audience?: string;
  primary_goal?: string;
  voice?: string;
  differentiators?: string[];
  forbidden_topics?: string[];
  red_id?: string;
  follower_count?: number | null;
  notes_count?: number | null;
  intro?: string;
  profile_url?: string;
  source?: "manual" | "screenshot";
}

/** Structured fields extracted from a profile screenshot (all optional). */
export interface AccountExtractResult {
  account_name: string;
  red_id: string;
  follower_count: number | null;
  notes_count: number | null;
  intro: string;
  niche: string;
}

export interface AgentTeamConfig {
  leader_name: string;
  leader_system_prompt: string;
  templates: Array<{ type: string; description: string }>;
  redis_mode: string;
  publishing: "manual";
}

export interface ModelConfig {
  credential_id: string;
  model_type: string;
  model: string;
  /** Display-only metadata (non-secret) so the settings dialog can show the current config. */
  api_type?: string;
  base_url?: string;
  model_name?: string;
}

export interface TeamPointer {
  agent_id: string;
  session_id: string;
}

export interface TeamMember {
  name: string;
  role: string;
  agent_id?: string;
  session_id?: string;
}

export interface CredentialSchema {
  type?: string;
  name?: string;
  schema?: JsonSchema;
  json_schema?: JsonSchema;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchema {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaProperty {
  title?: string;
  type?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  const?: string;
}

/**
 * A tool call block as carried by HITL confirm events. `input` is a JSON
 * string produced by the backend (parse before displaying parameters).
 */
export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  input: string;
  state?: "pending" | "asking" | "allowed" | "submitted" | "finished";
}

/** An inline image carried by DATA blocks, tool results or hint blocks. */
export interface ChatImage {
  blockId: string;
  mediaType: string;
  /** Either a `data:` URL (base64 payload) or a plain http(s) URL. */
  src: string;
}

/** A one-shot hint notice (team message, background tool result, …). */
export interface ChatHint {
  blockId?: string;
  source?: string;
  text: string;
  images?: ChatImage[];
}

/** Token usage accumulated across the model calls of one reply. */
export interface TokenUsage {
  modelName?: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Normalized SSE events emitted by the agent stream. Every event is tagged
 * with the `sessionId` of the stream it was read from (leader or worker) so
 * the reducer can route it. Argument DELTAs are accumulated by the caller.
 */
export type SseEvent =
  | { type: "REPLY_START"; sessionId: string; replyId: string; name: string }
  | { type: "REPLY_END"; sessionId: string; replyId: string; finishedReason: string }
  | { type: "TEXT_BLOCK_DELTA"; sessionId: string; replyId: string; blockId: string; delta: string }
  | { type: "THINKING_BLOCK_DELTA"; sessionId: string; replyId: string; blockId: string; delta: string }
  | { type: "DATA_BLOCK_DELTA"; sessionId: string; replyId: string; blockId: string; data: string; mediaType: string }
  | { type: "DATA_BLOCK_END"; sessionId: string; replyId: string; blockId: string }
  | { type: "HINT_BLOCK"; sessionId: string; replyId: string; blockId: string; source?: string; text: string; images: ChatImage[] }
  | { type: "MODEL_CALL_START"; sessionId: string; replyId: string; modelName: string }
  | { type: "MODEL_CALL_END"; sessionId: string; replyId: string; inputTokens: number; outputTokens: number }
  | { type: "TOOL_CALL_START"; sessionId: string; replyId: string; toolCallId: string; toolCallName: string }
  | { type: "TOOL_CALL_DELTA"; sessionId: string; replyId: string; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; sessionId: string; replyId: string; toolCallId: string }
  | { type: "TOOL_RESULT_START"; sessionId: string; replyId: string; toolCallId: string; toolCallName: string }
  | { type: "TOOL_RESULT_TEXT_DELTA"; sessionId: string; replyId: string; toolCallId: string; delta: string }
  | { type: "TOOL_RESULT_DATA_DELTA"; sessionId: string; replyId: string; toolCallId: string; blockId: string; mediaType: string; data?: string; url?: string }
  | { type: "TOOL_RESULT_END"; sessionId: string; replyId: string; toolCallId: string; state: string }
  | { type: "EXCEED_MAX_ITERS"; sessionId: string; replyId: string; name: string }
  | { type: "REQUIRE_EXTERNAL_EXECUTION"; sessionId: string; replyId: string; toolCalls: ToolCallBlock[] }
  | { type: "CUSTOM"; sessionId: string; name: string; value: Record<string, unknown> };

/** Payload of the `subagent_require_user_confirm` CUSTOM event. */
export interface SubagentRequireConfirmPayload {
  worker_session_id: string;
  worker_agent_id: string;
  worker_agent_name: string;
  reply_id: string;
  event_type: string;
  event: {
    type: string;
    reply_id: string;
    tool_calls: ToolCallBlock[];
  };
  created_at: string;
}

/** Payload of the `subagent_user_confirm_result` CUSTOM event. */
export interface SubagentConfirmResultPayload {
  worker_session_id: string;
  reply_id: string;
}

/** A tool invocation tracked on a task card (arguments accumulated live). */
export interface ToolCallInfo {
  id: string;
  name: string;
  argsText: string;
  args?: Record<string, unknown>;
  status: "running" | "done" | "error";
}

/** One step rendered in a task card's thought chain. */
export interface TaskStep {
  toolCallId: string;
  name: string;
  status: "running" | "done" | "error";
}

/**
 * One chronological entry in a worker's execution log. Text entries carry the
 * agent's running commentary; thinking entries its reasoning stream; tool
 * entries mark a tool invocation (with live output text and result images);
 * hint entries are one-shot notices (team messages, background results);
 * image entries are DATA blocks produced directly in the reply. Kept in
 * arrival order so the log panel can interleave everything chronologically.
 */
export type WorkerLogEntry =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "hint"; source?: string; text: string; images?: ChatImage[] }
  | { kind: "image"; image: ChatImage }
  | { kind: "tool"; toolCallId: string; name: string; status: "running" | "done" | "error"; output?: string; images?: ChatImage[] };

export type TaskStatus = "starting" | "working" | "confirm" | "done" | "error";

/** A pending HITL authorization request shown as a confirm card. */
export interface PendingConfirm {
  workerSessionId: string;
  replyId: string;
  workerName: string;
  toolCalls: ToolCallBlock[];
}

/** A pending external tool execution (e.g. ask_user) awaiting a user answer. */
export interface PendingExternal {
  replyId: string;
  toolCalls: ToolCallBlock[];
}

/** A locally staged composer image (pasted or picked) ready to send. */
export interface ComposerImage {
  id: string;
  mediaType: string;
  /** Raw base64 payload (no data: prefix). */
  data: string;
  /** data: URL for preview rendering. */
  src: string;
}

/** Upload/index status of one RAG attachment document. */
export interface AttachmentInfo {
  id: string;
  filename: string;
  status: "uploading" | "pending" | "processing" | "completed" | "failed";
  error?: string;
}

/** A subagent task rendered as a collapsible card inside the chat. */
export interface TaskCard {
  workerSessionId: string;
  agentName: string;
  role: string;
  status: TaskStatus;
  summary: string;
  steps: TaskStep[];
  narration: string;
  /** Chronological work log (commentary + tool calls) shown in the log panel. */
  entries: WorkerLogEntry[];
  replyId?: string;
  confirm?: PendingConfirm;
  /** Leader AgentCreate tool-call id that spawned this card (replay dedup). */
  createToolCallId?: string;
  /** Non-completed REPLY_END reason ("interrupted" / "exceed_max_iters"). */
  finishedReason?: string;
  /** Token usage accumulated across the worker's model calls. */
  usage?: TokenUsage;
}

export interface ChatMessageItem {
  kind: "message";
  id: string;
  role: "user" | "agent";
  name: string;
  text: string;
  streaming?: boolean;
  /** Accumulated reasoning stream (THINKING_BLOCK deltas). */
  thinking?: string;
  /** Non-completed REPLY_END reason ("interrupted" / "exceed_max_iters"). */
  finishedReason?: string;
  /** Token usage accumulated across this reply's model calls. */
  usage?: TokenUsage;
  /** Inline images streamed via DATA blocks. */
  images?: ChatImage[];
  /** One-shot hint notices attached to this reply. */
  hints?: ChatHint[];
  /** True when this user message was injected while the agent was running. */
  aside?: boolean;
  /** Pending external tool call (ask_user) awaiting the user's answer. */
  external?: PendingExternal;
}

export interface ChatTaskItem {
  kind: "task";
  id: string;
  task: TaskCard;
}

export type ChatItem = ChatMessageItem | ChatTaskItem;

/** A locally generated report served by the artifacts API. */
export interface Artifact {
  id: string;
  name: string;
  updated_at: string;
  size: number;
  /** True when a JSON data sibling exists so the app can render a native view. */
  has_data?: boolean;
}

/* ---- Report data payloads (JSON envelope from /artifacts/{id}/data) ---- */

export type ReportKind = "insight" | "title" | "account" | "cover";

/** One Xiaohongshu note row in insight reports (scores only on ranked items). */
export interface InsightNote {
  note_id: string;
  title: string;
  description: string;
  cover_url: string;
  note_url: string;
  author_id: string;
  author_name: string;
  author_url: string;
  author_fans: number;
  created_at: string;
  interactive_count: number;
  liked_count: number;
  collected_count: number;
  comments_count: number;
  shared_count: number;
  relevance_score?: number;
  popularity_score?: number;
  recency_score?: number;
  total_score?: number;
  recommendation_reason: string;
}

export interface InsightReportPayload {
  keyword: string;
  start_date: string;
  end_date: string;
  total: number;
  items: InsightNote[];
  latest_hot_articles: InsightNote[];
  related_searches: string[];
  hot_topics: string[];
  data_notice: string;
  sort_notice: string;
  queried_at?: string;
}

export interface TitleReference {
  note_id: string;
  title: string;
  url: string;
  author: string;
  interaction_count: number;
}

export interface TitleCandidate {
  rank: number;
  title: string;
  match_score: number;
  reason: string;
  references: TitleReference[];
}

export interface TitleDimension {
  key: string;
  label: string;
  weight: number;
  score: number;
  weighted_score: number;
}

export interface TitleRewrite {
  style: string;
  title: string;
  scene: string;
  expected_effect: string;
}

/** Title report: `mode` discriminates candidate generation vs scoring. */
export interface TitleReportPayload {
  mode: "generate" | "score";
  keyword: string;
  window_days?: number;
  sample_count: number;
  category_counts?: Record<string, number>;
  sample_warning?: string;
  data_notice: string;
  link_notice?: string;
  // generate mode
  patterns?: string[];
  titles?: TitleCandidate[];
  // score mode
  title?: string;
  score?: number;
  grade?: string;
  exact_sample_match?: boolean;
  dimensions?: TitleDimension[];
  issues?: string[];
  rewrites?: TitleRewrite[];
  highlights?: string[];
  references?: TitleReference[];
}

export interface BenchmarkAccount {
  account_id: string;
  nickname: string;
  profile_url: string;
  avatar_url: string;
  fans: number;
  level: string;
  track: string;
  interactive_30: number;
  interactive_7: number;
  notes_7: number;
  total_works: number;
  interaction_fan_ratio_30: number;
  recommendation_reason: string;
  content_analysis: string;
  data_updated_at: string;
}

export interface AccountReportPayload {
  criteria: {
    query_mode: string;
    red_id?: string;
    track?: string;
    min_fans?: number | null;
    max_fans?: number | null;
    level?: string;
  };
  summary: {
    same_level_count: number;
    high_level_count: number;
    kol_candidate_count: number;
    same_level_avg_fans: number;
    same_level_avg_interactive_30: number;
    high_level_avg_fans: number;
    high_level_avg_interactive_30: number;
  };
  same_level_accounts: BenchmarkAccount[];
  high_level_accounts: BenchmarkAccount[];
  kol_candidates: BenchmarkAccount[];
  data_updated_at: string;
  data_notice: string;
}

export interface CoverNote {
  note_id: string;
  title: string;
  description: string;
  cover_url: string;
  note_url: string;
  user_id: string;
  author_name: string;
  author_url: string;
  author_fans: number;
  interaction_count: number;
  liked_count: number;
  collected_count: number;
  comments_count: number;
  shared_count: number;
  source_group: string;
  published_at: string;
}

export interface CoverReportPayload {
  keyword: string;
  window_days: number;
  total_samples: number;
  category_counts: Record<string, number>;
  items: CoverNote[];
  data_notice: string;
}

export type ReportPayload =
  | InsightReportPayload
  | TitleReportPayload
  | AccountReportPayload
  | CoverReportPayload;

/** JSON envelope persisted alongside legacy HTML artifacts. */
export interface ReportEnvelope {
  kind: ReportKind;
  title: string;
  generated_at: string;
  payload: ReportPayload;
}

