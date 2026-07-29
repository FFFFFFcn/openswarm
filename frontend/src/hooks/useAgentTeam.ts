import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accountsApi, agentApi, ApiError, artifactsApi, kbApi, operationsApi, request } from "../api/client";
import type {
  AccountProfile,
  AgentTeamConfig,
  Artifact,
  AttachmentInfo,
  ChatImage,
  ChatItem,
  ChatMessageItem,
  ComposerImage,
  ConversationMeta,
  ModelConfig,
  PendingConfirm,
  PendingExternal,
  SseEvent,
  SubagentConfirmResultPayload,
  SubagentRequireConfirmPayload,
  TaskCard,
  TeamMember,
  TeamPointer,
} from "../api/types";
import {
  CUSTOM_CONFIRM_RESULT,
  CUSTOM_REQUIRE_CONFIRM,
  CUSTOM_STATE_UPDATED,
  CUSTOM_TEAM_UPDATED,
  readSseStream,
} from "../utils/sse";
import { readStored, writeStored } from "../utils/storage";
import { withAccountMarker } from "../utils/accountMarker";
import {
  conversationTitle,
  loadConversationArtifactIds,
  loadConversations,
  loadMessages,
  persistMessages,
  resetPollutedArtifactMappings,
  readLiveConversationId,
  removeConversation,
  saveConversationArtifactIds,
  saveConversations,
  writeLiveConversationId,
} from "../utils/conversations";

const MODEL_KEY = "openswarm-model";
const TEAM_KEY = "openswarm-team";
const LEGACY_MODEL_KEY = "reditor-model";
const LEGACY_TEAM_KEY = "reditor-team";
const MAX_RECONNECT_ATTEMPTS = 3;
/** How often background (non-viewed) running conversations are polled. */
const BACKGROUND_POLL_MS = 5_000;
/** Cap for accumulated thinking / narration streams (chars). */
const MAX_THINKING_CHARS = 20_000;
/** Cap for a tool's live output preview (chars, tail kept). */
const MAX_TOOL_OUTPUT_CHARS = 4_000;
/** Cap for one streamed DATA block's base64 payload (≈2MB binary). */
const MAX_DATA_BLOCK_CHARS = 2_800_000;

function readMigrated<T>(key: string, legacyKey: string): T | null {
  const current = readStored<T>(key);
  if (current) return current;
  const legacy = readStored<T>(legacyKey);
  if (legacy) {
    writeStored(key, legacy);
    writeStored(legacyKey, null);
  }
  return legacy;
}


/** Deep-enough copy so every flushed snapshot yields fresh references. */
function cloneTask(task: TaskCard): TaskCard {
  return {
    ...task,
    steps: task.steps.map((step) => ({ ...step })),
    entries: (task.entries ?? []).map((entry) =>
      entry.kind === "tool" || entry.kind === "hint"
        ? { ...entry, images: entry.images ? [...entry.images] : undefined }
        : { ...entry },
    ),
    usage: task.usage ? { ...task.usage } : undefined,
    confirm: task.confirm ? { ...task.confirm, toolCalls: [...task.confirm.toolCalls] } : undefined,
  };
}

/**
 * Internal skeleton stored in a runtime's `items`. Task payloads live in the
 * runtime's `tasks` map (keyed by item id) and are joined in `buildSnapshot`,
 * so the skeleton only needs the id.
 */
type ChatItemSkeleton = ChatMessageItem | { kind: "task"; id: string };

interface RosterMemberView {
  agent?: { id?: string; data?: { name?: string } };
  session_id?: string | null;
}

interface RosterResponse {
  sessions: Array<{
    session?: { id?: string };
    is_running?: boolean;
    team?: {
      team?: { data?: { members?: Array<{ agent_id: string; role: string }> } };
      members?: RosterMemberView[];
    };
  }>;
}

/**
 * Per-conversation runtime bucket: chat buffers, SSE controller and roster
 * state all live here so several conversations can run tasks concurrently
 * without sharing (or clobbering) each other's state. Buffers survive a
 * stream detach — only the currently viewed conversation keeps live SSE
 * connections (browser HTTP/1.1 caps same-origin connections at 6, and one
 * full team already needs leader + 5 workers).
 */
interface ConversationRuntime {
  team: TeamPointer | null;
  controller: AbortController | null;
  subscribed: Set<string>;
  items: ChatItemSkeleton[];
  texts: Map<string, string>;
  tasks: Map<string, TaskCard>;
  toolArgs: Map<string, string>;
  replyNames: Map<string, string>;
  /** In-flight DATA block accumulators keyed by block id (reply images and
   * base64 tool-result payloads); materialized on their END events. */
  dataBlocks: Map<string, { mediaType: string; toolCallId: string | null; chunks: string[]; size: number }>;
  members: TeamMember[];
  rosterTimer: number | null;
}

export function useAgentTeam() {
  const [model, setModelState] = useState<ModelConfig | null>(() => readMigrated<ModelConfig>(MODEL_KEY, LEGACY_MODEL_KEY));
  const [config, setConfig] = useState<AgentTeamConfig | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [runtimeMode, setRuntimeMode] = useState("正在检查服务");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [items, setItems] = useState<ChatItem[]>([]);

  // --- conversation history (sidebar) ---
  const [conversations, setConversations] = useState<ConversationMeta[]>(() => loadConversations());
  const [viewingId, setViewingId] = useState<string | null>(null);
  /** Every conversation currently executing a task (spinners in the sidebar). */
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());
  const viewingIdRef = useRef<string | null>(null);
  const runningIdsRef = useRef<Set<string>>(new Set());
  // Whether the artifact library baseline has been established (see
  // `refreshArtifacts`). Guards against attributing the pre-existing server
  // library to some conversation on the first load.
  const artifactsInitializedRef = useRef(false);

  // --- per-conversation runtime buckets ---
  const runtimesRef = useRef(new Map<string, ConversationRuntime>());
  const dirtyRef = useRef(new Set<string>());
  const flushScheduledRef = useRef(false);

  const modelRef = useRef<ModelConfig | null>(model);
  const configRef = useRef<AgentTeamConfig | null>(null);
  const refreshRosterRef = useRef<(conversationId: string) => Promise<void>>(async () => undefined);
  /** Conversation id → its own backend team (conversation isolation). */
  const teamsRef = useRef(new Map<string, TeamPointer>());
  /** Conversation id → its attachment knowledge base id (RAG). */
  const kbsRef = useRef(new Map<string, string>());
  /** RAG attachment upload/indexing status, keyed by conversation id. */
  const [attachmentsMap, setAttachmentsMap] = useState<Record<string, AttachmentInfo[]>>({});

  // --- account library & per-conversation account binding ---
  const [accounts, setAccounts] = useState<AccountProfile[]>([]);
  const [selectedAccount, setSelectedAccountState] = useState<{ id: string; name: string } | null>(null);
  /** Conversation id → bound account (mirrors ConversationMeta.account). */
  const accountBindingsRef = useRef(new Map<string, { id: string; name: string }>());
  /** Selection made on the welcome screen before a conversation exists. */
  const draftAccountRef = useRef<{ id: string; name: string } | null>(null);

  const refreshAccounts = useCallback(async () => {
    try {
      setAccounts(await accountsApi.list());
    } catch {
      // Account library unavailable — the selector just shows an empty list.
    }
  }, []);

  /** Bind an account to the viewed conversation (or the welcome-screen draft). */
  const setSelectedAccount = useCallback((account: { id: string; name: string } | null) => {
    setSelectedAccountState(account);
    const conversationId = viewingIdRef.current;
    if (!conversationId) {
      draftAccountRef.current = account;
      return;
    }
    if (account) accountBindingsRef.current.set(conversationId, account);
    else accountBindingsRef.current.delete(conversationId);
    setConversations((prev) => {
      const next = prev.map((item) => (item.id === conversationId ? { ...item, account: account ?? undefined } : item));
      saveConversations(next);
      return next;
    });
  }, []);

  /**
   * Get (or lazily create) a conversation's runtime bucket, hydrating its
   * buffers from the persisted archive on first touch.
   */
  const getRuntime = useCallback((conversationId: string): ConversationRuntime => {
    let runtime = runtimesRef.current.get(conversationId);
    if (runtime) return runtime;
    runtime = {
      team: teamsRef.current.get(conversationId) ?? null,
      controller: null,
      subscribed: new Set(),
      items: [],
      texts: new Map(),
      tasks: new Map(),
      toolArgs: new Map(),
      replyNames: new Map(),
      dataBlocks: new Map(),
      members: [],
      rosterTimer: null,
    };
    const archived = loadMessages(conversationId) ?? [];
    runtime.items = archived;
    for (const item of archived) {
      if (item.kind === "task") runtime.tasks.set(item.id, item.task);
      else if (item.kind === "message" && item.role === "agent") runtime.texts.set(item.id, item.text);
    }
    runtimesRef.current.set(conversationId, runtime);
    return runtime;
  }, []);

  const setRunningFor = useCallback((conversationId: string, value: boolean) => {
    if (runningIdsRef.current.has(conversationId) === value) return;
    const next = new Set(runningIdsRef.current);
    if (value) next.add(conversationId);
    else next.delete(conversationId);
    runningIdsRef.current = next;
    setRunningIds(next);
  }, []);

  const buildSnapshot = useCallback((runtime: ConversationRuntime): ChatItem[] => {
    const out: ChatItem[] = [];
    for (const item of runtime.items) {
      if (item.kind === "task") {
        const task = runtime.tasks.get(item.id);
        if (task) out.push({ kind: "task", id: item.id, task: cloneTask(task) });
      } else if (item.role === "agent") {
        out.push({ ...item, text: runtime.texts.get(item.id) ?? item.text ?? "" });
      } else {
        out.push(item);
      }
    }
    return out;
  }, []);

  const scheduleFlush = useCallback((conversationId: string) => {
    dirtyRef.current.add(conversationId);
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    requestAnimationFrame(() => {
      flushScheduledRef.current = false;
      const dirty = [...dirtyRef.current];
      dirtyRef.current.clear();
      for (const id of dirty) {
        const runtime = runtimesRef.current.get(id);
        if (!runtime) continue;
        const snapshot = buildSnapshot(runtime);
        persistMessages(id, snapshot);
        // Only repaint the display for the conversation that's shown; other
        // conversations still persist their progress in the background.
        if (viewingIdRef.current === id) setItems(snapshot);
      }
    });
  }, [buildSnapshot]);

  const refreshArtifacts = useCallback((conversationId?: string) => {
    void artifactsApi.list().then((list) => {
      // The server artifact library persists across sessions, so the first
      // load only establishes a baseline — it must never bulk-attribute
      // pre-existing artifacts to some conversation. Only artifacts appearing
      // in a later refresh (produced by a task this session) are attributed
      // to the conversation whose event triggered the refresh.
      const initialized = artifactsInitializedRef.current;
      artifactsInitializedRef.current = true;
      setArtifacts((prev) => {
        if (initialized && conversationId && list.length > prev.length) {
          const prevIds = new Set(prev.map((a) => a.id));
          const newIds = list.filter((a) => !prevIds.has(a.id)).map((a) => a.id);
          if (newIds.length) {
            const existing = loadConversationArtifactIds(conversationId);
            saveConversationArtifactIds(conversationId, [...new Set([...existing, ...newIds])]);
          }
        }
        return list;
      });
    }).catch(() => undefined);
  }, []);

  /**
   * Re-key a `pending:*` task card (created from the leader's AgentCreate
   * call before the worker session existed) onto the worker's real session
   * id. Prefers a name match, falls back to the first pending card.
   */
  const adoptPendingCard = useCallback((runtime: ConversationRuntime, sessionId: string, matchName?: string, role?: string): TaskCard | null => {
    const existing = runtime.tasks.get(sessionId);
    if (existing) {
      if (role && !existing.role) existing.role = role;
      return existing;
    }
    let nameMatchKey: string | null = null;
    let firstPendingKey: string | null = null;
    for (const key of runtime.tasks.keys()) {
      if (!key.startsWith("pending:")) continue;
      if (firstPendingKey === null) firstPendingKey = key;
      if (matchName && runtime.tasks.get(key)?.agentName === matchName) {
        nameMatchKey = key;
        break;
      }
    }
    const key = nameMatchKey ?? firstPendingKey;
    if (!key) return null;
    const card = runtime.tasks.get(key)!;
    runtime.tasks.delete(key);
    card.workerSessionId = sessionId;
    if (role && !card.role) card.role = role;
    runtime.tasks.set(sessionId, card);
    const item = runtime.items.find((entry) => entry.id === key);
    if (item) item.id = sessionId;
    return card;
  }, []);

  const ensureWorkerCard = useCallback((runtime: ConversationRuntime, sessionId: string, name?: string, replyId?: string): TaskCard => {
    let card = runtime.tasks.get(sessionId) ?? adoptPendingCard(runtime, sessionId, name) ?? undefined;
    if (!card) {
      card = { workerSessionId: sessionId, agentName: name ?? "智能体", role: "", status: "working", summary: "", steps: [], narration: "", entries: [] };
      runtime.tasks.set(sessionId, card);
      runtime.items.push({ kind: "task", id: sessionId });
    }
    if (replyId) card.replyId = replyId;
    return card;
  }, [adoptPendingCard]);

  /**
   * Find (or create) the leader message item for a reply. Deltas can beat
   * REPLY_START on a freshly replayed stream, so every leader branch goes
   * through this fallback.
   */
  const ensureLeaderMessage = useCallback((runtime: ConversationRuntime, replyId: string): ChatMessageItem => {
    const itemId = `reply:${replyId}`;
    const existing = runtime.items.find((entry) => entry.id === itemId);
    if (existing && existing.kind === "message") return existing;
    const item: ChatMessageItem = { kind: "message", id: itemId, role: "agent", name: runtime.replyNames.get(replyId) ?? "主理人", text: "", streaming: true };
    runtime.texts.set(itemId, runtime.texts.get(itemId) ?? "");
    runtime.items.push(item);
    return item;
  }, []);

  /** Append a chronological entry to a worker card, merging trailing streams. */
  const appendStreamEntry = useCallback((card: TaskCard, kind: "text" | "thinking", delta: string) => {
    const last = card.entries[card.entries.length - 1];
    if (last && last.kind === kind) {
      last.text = `${last.text}${delta}`.slice(-MAX_THINKING_CHARS);
    } else {
      card.entries.push({ kind, text: delta });
    }
  }, []);

  const handleEvent = useCallback((conversationId: string, event: SseEvent) => {
    const runtime = runtimesRef.current.get(conversationId);
    if (!runtime) return;
    const isLeader = event.sessionId === runtime.team?.session_id;

    switch (event.type) {
      case "REPLY_START": {
        if (isLeader) {
          runtime.replyNames.set(event.replyId, event.name);
          const itemId = `reply:${event.replyId}`;
          const existing = runtime.items.find((entry) => entry.id === itemId);
          if (existing) {
            if (existing.kind === "message") {
              if (!existing.streaming) {
                // Restored from the archive, and the SSE replay log is
                // re-sending this reply's deltas — rebuild the text from
                // scratch instead of appending a second copy.
                runtime.texts.set(itemId, "");
                existing.thinking = undefined;
                existing.images = undefined;
                existing.hints = undefined;
                existing.usage = undefined;
                existing.finishedReason = undefined;
                existing.external = undefined;
              }
              existing.streaming = true;
            }
          } else {
            runtime.texts.set(itemId, "");
            runtime.items.push({ kind: "message", id: itemId, role: "agent", name: event.name, text: "", streaming: true });
          }
          setRunningFor(conversationId, true);
        } else {
          const card = ensureWorkerCard(runtime, event.sessionId, event.name, event.replyId);
          // REPLY_START fires once per reply; hitting an already-restored
          // card means the replay log is rebuilding the run — clear stale
          // narration/log so replayed deltas don't duplicate it.
          card.narration = "";
          card.entries = [];
          card.usage = undefined;
          card.finishedReason = undefined;
        }
        break;
      }
      case "TEXT_BLOCK_DELTA": {
        if (isLeader) {
          const item = ensureLeaderMessage(runtime, event.replyId);
          runtime.texts.set(item.id, `${runtime.texts.get(item.id) ?? ""}${event.delta}`);
        } else {
          const card = ensureWorkerCard(runtime, event.sessionId);
          card.narration = `${card.narration}${event.delta}`.slice(-MAX_THINKING_CHARS);
          // Append to the trailing commentary entry, or start a new one when
          // the previous entry is a tool call — this keeps commentary and tool
          // calls interleaved in arrival order.
          appendStreamEntry(card, "text", event.delta);
        }
        break;
      }
      case "THINKING_BLOCK_DELTA": {
        if (isLeader) {
          const item = ensureLeaderMessage(runtime, event.replyId);
          item.thinking = `${item.thinking ?? ""}${event.delta}`.slice(-MAX_THINKING_CHARS);
        } else {
          const card = ensureWorkerCard(runtime, event.sessionId);
          appendStreamEntry(card, "thinking", event.delta);
        }
        break;
      }
      case "MODEL_CALL_START": {
        if (!event.modelName) break;
        if (isLeader) {
          const item = ensureLeaderMessage(runtime, event.replyId);
          item.usage = { ...(item.usage ?? { inputTokens: 0, outputTokens: 0 }), modelName: event.modelName };
        } else {
          const card = ensureWorkerCard(runtime, event.sessionId);
          card.usage = { ...(card.usage ?? { inputTokens: 0, outputTokens: 0 }), modelName: event.modelName };
        }
        break;
      }
      case "MODEL_CALL_END": {
        // A reply can span several model calls — accumulate the totals.
        if (isLeader) {
          const item = ensureLeaderMessage(runtime, event.replyId);
          const usage = item.usage ?? { inputTokens: 0, outputTokens: 0 };
          item.usage = { ...usage, inputTokens: usage.inputTokens + event.inputTokens, outputTokens: usage.outputTokens + event.outputTokens };
        } else {
          const card = ensureWorkerCard(runtime, event.sessionId);
          const usage = card.usage ?? { inputTokens: 0, outputTokens: 0 };
          card.usage = { ...usage, inputTokens: usage.inputTokens + event.inputTokens, outputTokens: usage.outputTokens + event.outputTokens };
        }
        break;
      }
      case "DATA_BLOCK_DELTA": {
        const bucket = runtime.dataBlocks.get(event.blockId) ?? { mediaType: event.mediaType, toolCallId: null, chunks: [], size: 0 };
        if (bucket.size < MAX_DATA_BLOCK_CHARS) {
          bucket.chunks.push(event.data);
          bucket.size += event.data.length;
        }
        runtime.dataBlocks.set(event.blockId, bucket);
        break;
      }
      case "DATA_BLOCK_END": {
        const bucket = runtime.dataBlocks.get(event.blockId);
        runtime.dataBlocks.delete(event.blockId);
        if (!bucket || bucket.size === 0 || bucket.size >= MAX_DATA_BLOCK_CHARS) break;
        const image: ChatImage = { blockId: event.blockId, mediaType: bucket.mediaType, src: `data:${bucket.mediaType};base64,${bucket.chunks.join("")}` };
        if (isLeader) {
          const item = ensureLeaderMessage(runtime, event.replyId);
          item.images = [...(item.images ?? []).filter((entry) => entry.blockId !== event.blockId), image];
        } else {
          const card = ensureWorkerCard(runtime, event.sessionId);
          if (!card.entries.some((entry) => entry.kind === "image" && entry.image.blockId === event.blockId)) {
            card.entries.push({ kind: "image", image });
          }
        }
        break;
      }
      case "HINT_BLOCK": {
        if (isLeader) {
          const item = ensureLeaderMessage(runtime, event.replyId);
          item.hints = [
            ...(item.hints ?? []).filter((entry) => entry.blockId !== event.blockId),
            { blockId: event.blockId, source: event.source, text: event.text, images: event.images.length ? event.images : undefined },
          ];
        } else {
          const card = ensureWorkerCard(runtime, event.sessionId);
          card.entries.push({ kind: "hint", source: event.source, text: event.text, images: event.images.length ? event.images : undefined });
        }
        break;
      }
      case "TOOL_CALL_START": {
        if (isLeader) {
          if (event.toolCallName === "AgentCreate") runtime.toolArgs.set(event.toolCallId, "");
        } else {
          const card = ensureWorkerCard(runtime, event.sessionId);
          card.status = card.status === "confirm" ? "confirm" : "working";
          const step = card.steps.find((entry) => entry.toolCallId === event.toolCallId);
          if (step) {
            step.name = event.toolCallName;
            step.status = "running";
          } else {
            card.steps.push({ toolCallId: event.toolCallId, name: event.toolCallName, status: "running" });
          }
          const toolEntry = card.entries.find(
            (entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId,
          );
          if (toolEntry && toolEntry.kind === "tool") {
            toolEntry.name = event.toolCallName;
            toolEntry.status = "running";
          } else {
            card.entries.push({ kind: "tool", toolCallId: event.toolCallId, name: event.toolCallName, status: "running" });
          }
        }
        break;
      }
      case "TOOL_CALL_DELTA": {
        if (isLeader && runtime.toolArgs.has(event.toolCallId)) {
          runtime.toolArgs.set(event.toolCallId, `${runtime.toolArgs.get(event.toolCallId) ?? ""}${event.delta}`);
        }
        break;
      }
      case "TOOL_CALL_END": {
        if (isLeader && runtime.toolArgs.has(event.toolCallId)) {
          const raw = runtime.toolArgs.get(event.toolCallId) ?? "";
          runtime.toolArgs.delete(event.toolCallId);
          const pendingKey = `pending:${event.toolCallId}`;
          // Skip replayed AgentCreate completions already represented by an
          // existing (possibly re-keyed onto the worker session) task card.
          const alreadyTracked =
            runtime.tasks.has(pendingKey) ||
            Array.from(runtime.tasks.values()).some((card) => card.createToolCallId === event.toolCallId);
          if (alreadyTracked) break;
          let agentName = "新成员";
          let role = "";
          let summary = "";
          try {
            const args = JSON.parse(raw) as { name?: string; subagent_type?: string; prompt?: string };
            agentName = args.name ?? agentName;
            role = args.subagent_type ?? role;
            summary = args.prompt ?? summary;
          } catch {
            // Partial args — the roster will fill in the real name later.
          }
          runtime.tasks.set(pendingKey, { workerSessionId: pendingKey, agentName, role, status: "starting", summary, steps: [], narration: "", entries: [], createToolCallId: event.toolCallId });
          runtime.items.push({ kind: "task", id: pendingKey });
        }
        break;
      }
      case "TOOL_RESULT_TEXT_DELTA": {
        if (!isLeader) {
          const card = ensureWorkerCard(runtime, event.sessionId);
          const toolEntry = card.entries.find(
            (entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId,
          );
          if (toolEntry && toolEntry.kind === "tool") {
            toolEntry.output = `${toolEntry.output ?? ""}${event.delta}`.slice(-MAX_TOOL_OUTPUT_CHARS);
          }
        }
        break;
      }
      case "TOOL_RESULT_DATA_DELTA": {
        if (isLeader) break;
        if (event.url) {
          // URL results are complete in one event — attach immediately.
          const card = ensureWorkerCard(runtime, event.sessionId);
          const toolEntry = card.entries.find(
            (entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId,
          );
          if (toolEntry && toolEntry.kind === "tool" && !(toolEntry.images ?? []).some((img) => img.blockId === event.blockId)) {
            toolEntry.images = [...(toolEntry.images ?? []), { blockId: event.blockId, mediaType: event.mediaType, src: event.url }];
          }
        } else if (event.data) {
          // Base64 payloads may be chunked — accumulate until TOOL_RESULT_END.
          const bucket = runtime.dataBlocks.get(event.blockId) ?? { mediaType: event.mediaType, toolCallId: event.toolCallId, chunks: [], size: 0 };
          if (bucket.size < MAX_DATA_BLOCK_CHARS) {
            bucket.chunks.push(event.data);
            bucket.size += event.data.length;
          }
          runtime.dataBlocks.set(event.blockId, bucket);
        }
        break;
      }
      case "TOOL_RESULT_END": {
        if (!isLeader) {
          const card = ensureWorkerCard(runtime, event.sessionId);
          const step = card.steps.find((entry) => entry.toolCallId === event.toolCallId);
          if (step) step.status = event.state === "success" ? "done" : "error";
          const toolEntry = card.entries.find(
            (entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId,
          );
          if (toolEntry && toolEntry.kind === "tool") {
            toolEntry.status = event.state === "success" ? "done" : "error";
            // Materialize any base64 result blocks accumulated for this call.
            for (const [blockId, bucket] of runtime.dataBlocks) {
              if (bucket.toolCallId !== event.toolCallId) continue;
              runtime.dataBlocks.delete(blockId);
              if (bucket.size === 0 || bucket.size >= MAX_DATA_BLOCK_CHARS) continue;
              if (!(toolEntry.images ?? []).some((img) => img.blockId === blockId)) {
                toolEntry.images = [...(toolEntry.images ?? []), { blockId, mediaType: bucket.mediaType, src: `data:${bucket.mediaType};base64,${bucket.chunks.join("")}` }];
              }
            }
          }
        }
        break;
      }
      case "EXCEED_MAX_ITERS": {
        if (isLeader) {
          ensureLeaderMessage(runtime, event.replyId).finishedReason = "exceed_max_iters";
        } else {
          const card = runtime.tasks.get(event.sessionId);
          if (card) card.finishedReason = "exceed_max_iters";
        }
        break;
      }
      case "REQUIRE_EXTERNAL_EXECUTION": {
        // The run parks until the user answers — surface the question on the
        // leader reply and release the running marker so the composer frees up.
        if (isLeader) {
          const item = ensureLeaderMessage(runtime, event.replyId);
          item.streaming = false;
          item.external = { replyId: event.replyId, toolCalls: event.toolCalls };
          setRunningFor(conversationId, false);
        }
        break;
      }
      case "REPLY_END": {
        const abnormal = event.finishedReason === "interrupted" || event.finishedReason === "exceed_max_iters";
        if (isLeader) {
          const itemId = `reply:${event.replyId}`;
          const existing = runtime.items.find((entry) => entry.id === itemId);
          if (existing && existing.kind === "message") {
            existing.streaming = false;
            existing.external = undefined;
            if (abnormal) existing.finishedReason = event.finishedReason;
          }
          setRunningFor(conversationId, false);
        } else {
          const card = runtime.tasks.get(event.sessionId);
          if (card) {
            card.status = "done";
            card.confirm = undefined;
            if (abnormal) card.finishedReason = event.finishedReason;
          }
          refreshArtifacts(conversationId);
        }
        break;
      }
      case "CUSTOM": {
        if (event.name === CUSTOM_REQUIRE_CONFIRM) {
          const payload = event.value as unknown as SubagentRequireConfirmPayload;
          const card = ensureWorkerCard(runtime, payload.worker_session_id, payload.worker_agent_name);
          card.status = "confirm";
          card.confirm = {
            workerSessionId: payload.worker_session_id,
            replyId: payload.reply_id,
            workerName: payload.worker_agent_name,
            toolCalls: payload.event?.tool_calls ?? [],
          };
        } else if (event.name === CUSTOM_CONFIRM_RESULT) {
          const payload = event.value as unknown as SubagentConfirmResultPayload;
          const card = runtime.tasks.get(payload.worker_session_id);
          if (card) {
            card.confirm = undefined;
            if (card.status === "confirm") card.status = "working";
          }
        } else if (event.name === CUSTOM_TEAM_UPDATED || event.name === CUSTOM_STATE_UPDATED) {
          // Push-style roster notification — refresh immediately instead of
          // waiting for the generic post-event debounce.
          if (runtime.rosterTimer !== null) {
            window.clearTimeout(runtime.rosterTimer);
            runtime.rosterTimer = null;
          }
          void refreshRosterRef.current(conversationId);
        }
        break;
      }
      default:
        break;
    }
    scheduleFlush(conversationId);
  }, [appendStreamEntry, ensureLeaderMessage, ensureWorkerCard, refreshArtifacts, scheduleFlush, setRunningFor]);

  /** Subscribe to one session's SSE stream with bounded auto-reconnect. */
  const subscribeStream = useCallback((conversationId: string, sessionId: string, agentId: string) => {
    const runtime = runtimesRef.current.get(conversationId);
    if (!runtime) return;
    const controller = runtime.controller;
    if (!controller || controller.signal.aborted) return;
    if (runtime.subscribed.has(sessionId)) return;
    runtime.subscribed.add(sessionId);
    void (async () => {
      let attempt = 0;
      while (!controller.signal.aborted) {
        try {
          await readSseStream(
            `/sessions/${sessionId}/stream?agent_id=${agentId}`,
            sessionId,
            (event) => {
              handleEvent(conversationId, event);
              if (runtime.rosterTimer === null) {
                runtime.rosterTimer = window.setTimeout(() => {
                  runtime.rosterTimer = null;
                  void refreshRosterRef.current(conversationId);
                }, 1_200);
              }
            },
            controller.signal,
          );
          break;
        } catch (reason) {
          if (controller.signal.aborted) break;
          if (reason instanceof DOMException && reason.name === "AbortError") break;
          attempt += 1;
          if (attempt > MAX_RECONNECT_ATTEMPTS) {
            console.warn("事件流重连失败", reason);
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1_000 * 2 ** (attempt - 1)));
        }
      }
    })();
  }, [handleEvent]);

  const refreshRoster = useCallback(async (conversationId: string) => {
    const runtime = runtimesRef.current.get(conversationId);
    const pointer = runtime?.team ?? teamsRef.current.get(conversationId) ?? null;
    if (!runtime || !pointer) return;
    try {
      const sessionData = await request<RosterResponse>(`/sessions/?agent_id=${pointer.agent_id}`);
      const entry = sessionData.sessions.find((item) => item.session?.id === pointer.session_id);
      setRunningFor(conversationId, Boolean(entry?.is_running));
      const roles = new Map((entry?.team?.team?.data?.members ?? []).map((member) => [member.agent_id, member.role]));
      const nextMembers: TeamMember[] = (entry?.team?.members ?? []).map((member) => ({
        name: member.agent?.data?.name ?? `Worker ${(member.agent?.id ?? "unknown").slice(0, 6)}`,
        role: roles.get(member.agent?.id ?? "") ?? "created",
        agent_id: member.agent?.id,
        session_id: member.session_id ?? undefined,
      }));
      runtime.members = nextMembers;
      if (viewingIdRef.current === conversationId) setMembers(nextMembers);
      for (const member of nextMembers) {
        if (member.session_id && member.agent_id && !runtime.subscribed.has(member.session_id)) {
          adoptPendingCard(runtime, member.session_id, member.name, member.role);
          subscribeStream(conversationId, member.session_id, member.agent_id);
        }
      }
      scheduleFlush(conversationId);
    } catch {
      // Transient roster failure — keep current members/markers; the
      // background poll or the next SSE event will reconcile.
    }
  }, [adoptPendingCard, scheduleFlush, setRunningFor, subscribeStream]);

  useEffect(() => {
    refreshRosterRef.current = refreshRoster;
  }, [refreshRoster]);

  /**
   * Attach live SSE streams to a conversation (leader first, workers via the
   * roster). Only the viewed conversation holds streams — see the runtime
   * doc comment for the connection-limit rationale.
   */
  const attachStreams = useCallback((conversationId: string) => {
    const runtime = runtimesRef.current.get(conversationId);
    const pointer = runtime?.team;
    if (!runtime || !pointer) return;
    if (!runtime.controller || runtime.controller.signal.aborted) {
      runtime.controller = new AbortController();
      runtime.subscribed = new Set();
      // A fresh attach replays the server-side event log. Clear stale
      // streaming flags so replayed REPLY_STARTs rebuild each reply's text
      // from scratch instead of appending a second copy.
      for (const item of runtime.items) {
        if (item.kind === "message") item.streaming = false;
      }
    }
    subscribeStream(conversationId, pointer.session_id, pointer.agent_id);
    void refreshRoster(conversationId);
  }, [refreshRoster, subscribeStream]);

  /** Detach a conversation's SSE streams, keeping its buffers intact. */
  const detachStreams = useCallback((conversationId: string) => {
    const runtime = runtimesRef.current.get(conversationId);
    if (!runtime) return;
    runtime.controller?.abort();
    runtime.controller = null;
    runtime.subscribed = new Set();
    if (runtime.rosterTimer !== null) {
      window.clearTimeout(runtime.rosterTimer);
      runtime.rosterTimer = null;
    }
  }, []);

  const deleteTeamAgent = useCallback(async (pointer: TeamPointer | null) => {
    if (!pointer) return;
    try {
      await request(`/agent/${pointer.agent_id}`, { method: "DELETE" });
    } catch (reason) {
      if (!(reason instanceof ApiError && reason.status === 404)) throw reason;
    }
  }, []);

  /** Mirror a conversation's team pointer into registry, runtime and storage. */
  const setConversationTeam = useCallback((id: string, value: TeamPointer | null) => {
    if (value) teamsRef.current.set(id, value);
    else teamsRef.current.delete(id);
    const runtime = runtimesRef.current.get(id);
    if (runtime) runtime.team = value;
    setConversations((prev) => {
      const next = prev.map((item) =>
        item.id === id ? { ...item, team: value ?? undefined } : item,
      );
      saveConversations(next);
      return next;
    });
  }, []);

  const setModel = useCallback(async (value: ModelConfig | null) => {
    // Model changes only affect teams created afterwards; every existing
    // conversation keeps its own backend team (conversation isolation).
    modelRef.current = value;
    setModelState(value);
    writeStored(MODEL_KEY, value);
  }, []);

  /**
   * Return the backend team owned by `conversationId`, creating a fresh
   * leader agent + session on first use. Every conversation gets its own
   * team so agent memory never leaks across conversations.
   */
  const ensureTeam = useCallback(async (conversationId: string): Promise<TeamPointer> => {
    const existing = teamsRef.current.get(conversationId);
    if (existing) return existing;
    if (!modelRef.current) throw new Error("请先在模型设置中保存凭据");
    const activeConfig = configRef.current ?? await operationsApi.teamConfig();
    configRef.current = activeConfig;
    setConfig(activeConfig);
    const agent = await agentApi.createLeader(activeConfig.leader_name, activeConfig.leader_system_prompt);
    let session;
    try {
      session = await agentApi.createSession(agent.agent_id, modelRef.current);
    } catch (reason) {
      await request(`/agent/${agent.agent_id}`, { method: "DELETE" }).catch(() => undefined);
      // Credential missing server-side (e.g. vault file removed) — clear stale config
      if (reason instanceof ApiError && /credential/i.test(reason.message)) {
        modelRef.current = null;
        setModelState(null);
        writeStored(MODEL_KEY, null);
        throw new Error("模型凭据已失效，请在“设置”中重新保存凭据。");
      }
      throw reason;
    }
    const next = { agent_id: agent.agent_id, session_id: session.session_id };
    setConversationTeam(conversationId, next);
    return next;
  }, [setConversationTeam]);

  /** Create a conversation entry for the first user message of a new task. */
  const startConversation = useCallback((text: string): string => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const meta: ConversationMeta = {
      id,
      title: conversationTitle(text),
      createdAt: now,
      updatedAt: now,
      account: draftAccountRef.current ?? undefined,
    };
    if (draftAccountRef.current) accountBindingsRef.current.set(id, draftAccountRef.current);
    viewingIdRef.current = id;
    setViewingId(id);
    writeLiveConversationId(id);
    getRuntime(id);
    setConversations((prev) => {
      const next = [meta, ...prev.filter((item) => item.id !== id)];
      saveConversations(next);
      return next;
    });
    return id;
  }, [getRuntime]);

  /**
   * Send a message in the currently viewed conversation (creating one when
   * the welcome screen is shown). Other conversations' runtimes and streams
   * are untouched, so their tasks keep running concurrently. While a run is
   * in progress the message is steered into the running sessions' inboxes
   * instead of starting a new turn.
   */
  const sendMessage = useCallback(async (text: string, images: ComposerImage[] = []) => {
    let targetId = viewingIdRef.current;
    if (!targetId) {
      targetId = startConversation(text || "图片消息");
    } else {
      const active = targetId;
      setConversations((prev) => {
        const next = prev.map((item) => (item.id === active ? { ...item, updatedAt: Date.now() } : item));
        saveConversations(next);
        return next;
      });
    }
    const runtime = getRuntime(targetId);
    const chatImages: ChatImage[] | undefined = images.length
      ? images.map((image) => ({ blockId: image.id, mediaType: image.mediaType, src: image.src }))
      : undefined;
    // The account marker only rides on the backend copy — the local echo and
    // the archive keep the clean text the user typed.
    const outboundText = withAccountMarker(text, accountBindingsRef.current.get(targetId) ?? null);
    const pointer = runtime.team ?? teamsRef.current.get(targetId) ?? null;
    if (runningIdsRef.current.has(targetId) && pointer) {
      // Mid-run steering: push the hint into the leader's and every worker's
      // inbox — the agents pick it up at their next reasoning step.
      runtime.items.push({ kind: "message", id: crypto.randomUUID(), role: "user", name: "你", text, aside: true, images: chatImages });
      scheduleFlush(targetId);
      const targets = [
        { agent_id: pointer.agent_id, session_id: pointer.session_id },
        ...runtime.members
          .filter((member) => member.agent_id && member.session_id)
          .map((member) => ({ agent_id: member.agent_id!, session_id: member.session_id! })),
      ];
      await agentApi.steer(targets, outboundText, images);
      return;
    }
    runtime.items.push({ kind: "message", id: crypto.randomUUID(), role: "user", name: "你", text, images: chatImages });
    scheduleFlush(targetId);
    setRunningFor(targetId, true);
    try {
      let activeTeam = await ensureTeam(targetId);
      runtime.team = activeTeam;
      attachStreams(targetId);
      try {
        await agentApi.send(activeTeam, outboundText, images);
      } catch (reason) {
        // After a backend restart the agent/session records are gone even
        // though the pointer is persisted; rebuild this conversation's own
        // team once and retry.
        if (!(reason instanceof ApiError && reason.status === 404)) throw reason;
        detachStreams(targetId);
        setConversationTeam(targetId, null);
        activeTeam = await ensureTeam(targetId);
        runtime.team = activeTeam;
        attachStreams(targetId);
        await agentApi.send(activeTeam, outboundText, images);
      }
      window.setTimeout(() => void refreshRoster(targetId!), 800);
    } catch (reason) {
      setRunningFor(targetId, false);
      throw reason;
    }
  }, [attachStreams, detachStreams, ensureTeam, getRuntime, refreshRoster, scheduleFlush, setConversationTeam, setRunningFor, startConversation]);

  /**
   * Resume an interrupted / parked run from the backend's persisted agent
   * state (`input: null`). A 409 means the session is already running —
   * treat it as success and just reattach.
   */
  const continueRun = useCallback(async () => {
    const targetId = viewingIdRef.current;
    if (!targetId) return;
    const runtime = getRuntime(targetId);
    const pointer = runtime.team ?? teamsRef.current.get(targetId) ?? null;
    if (!pointer) return;
    setRunningFor(targetId, true);
    runtime.team = pointer;
    attachStreams(targetId);
    try {
      await agentApi.continueRun(pointer);
    } catch (reason) {
      if (!(reason instanceof ApiError && reason.status === 409)) {
        setRunningFor(targetId, false);
        throw reason;
      }
    }
    window.setTimeout(() => void refreshRoster(targetId), 800);
  }, [attachStreams, getRuntime, refreshRoster, setRunningFor]);

  /** Answer a parked external tool call (ask_user) and resume the run. */
  const submitExternal = useCallback(async (external: PendingExternal, answer: string) => {
    const conversationId = viewingIdRef.current;
    if (!conversationId) return;
    const runtime = runtimesRef.current.get(conversationId);
    const pointer = runtime?.team ?? teamsRef.current.get(conversationId) ?? null;
    if (!runtime || !pointer) return;
    setRunningFor(conversationId, true);
    try {
      await agentApi.externalResult(
        pointer,
        external.replyId,
        external.toolCalls.map((call) => ({ id: call.id, name: call.name, output: answer })),
      );
    } catch (reason) {
      setRunningFor(conversationId, false);
      throw reason;
    }
    const item = runtime.items.find((entry) => entry.id === `reply:${external.replyId}`);
    if (item && item.kind === "message") item.external = undefined;
    runtime.items.push({ kind: "message", id: crypto.randomUUID(), role: "user", name: "你", text: answer, aside: true });
    scheduleFlush(conversationId);
  }, [scheduleFlush, setRunningFor]);

  /** Persist a conversation's attachment knowledge base id into its meta. */
  const setConversationKb = useCallback((id: string, kbId: string) => {
    kbsRef.current.set(id, kbId);
    setConversations((prev) => {
      const next = prev.map((item) => (item.id === id ? { ...item, kb: { id: kbId } } : item));
      saveConversations(next);
      return next;
    });
  }, []);

  const patchAttachment = useCallback((conversationId: string, id: string, patch: Partial<AttachmentInfo>) => {
    setAttachmentsMap((prev) => ({
      ...prev,
      [conversationId]: (prev[conversationId] ?? []).map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    }));
  }, []);

  /**
   * Attach documents to the conversation as RAG context: lazily create a
   * knowledge base (first available embedding model), wire it into the
   * leader session, upload the files and poll indexing status.
   */
  const attachFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    let targetId = viewingIdRef.current;
    if (!targetId) targetId = startConversation(`附件：${files[0]?.name ?? "文档"}`);
    const conversationId = targetId;
    const runtime = getRuntime(conversationId);
    const team = await ensureTeam(conversationId);
    runtime.team = team;
    let kbId = kbsRef.current.get(conversationId) ?? null;
    if (!kbId) {
      const option = await kbApi.firstEmbeddingOption();
      if (!option) throw new Error("没有可用的向量化模型，无法建立附件知识库。");
      const created = await kbApi.create(`会话附件-${conversationId.slice(0, 8)}`, option);
      kbId = created.knowledge_base_id;
      setConversationKb(conversationId, kbId);
      await agentApi.patchSession(team, { knowledge_config: { knowledge_base_ids: [kbId], parameters: {} } });
    }
    const pendingIds: string[] = [];
    for (const file of files) {
      const tempId = crypto.randomUUID();
      setAttachmentsMap((prev) => ({
        ...prev,
        [conversationId]: [...(prev[conversationId] ?? []), { id: tempId, filename: file.name, status: "uploading" }],
      }));
      try {
        const uploaded = await kbApi.uploadDocument(kbId, file);
        patchAttachment(conversationId, tempId, { id: uploaded.document_id, status: "pending" });
        pendingIds.push(uploaded.document_id);
      } catch (reason) {
        patchAttachment(conversationId, tempId, { status: "failed", error: reason instanceof Error ? reason.message : "上传失败" });
      }
    }
    // Poll indexing status until every uploaded document settles (bounded).
    const waiting = new Set(pendingIds);
    for (let attempt = 0; attempt < 60 && waiting.size > 0; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      try {
        const { items: statuses } = await kbApi.documentsStatus(kbId, [...waiting]);
        for (const status of statuses) {
          if (status.status === "completed") {
            waiting.delete(status.id);
            patchAttachment(conversationId, status.id, { status: "completed" });
          } else if (status.status === "failed") {
            waiting.delete(status.id);
            patchAttachment(conversationId, status.id, { status: "failed", error: status.error ?? undefined });
          } else {
            patchAttachment(conversationId, status.id, { status: "processing" });
          }
        }
      } catch {
        // Transient status failure — keep polling.
      }
    }
    for (const id of waiting) patchAttachment(conversationId, id, { status: "failed", error: "索引超时" });
  }, [ensureTeam, getRuntime, patchAttachment, setConversationKb, startConversation]);

  /**
   * Resolve the agent + model config a scheduled task should run with
   * (the viewed conversation's leader; a fresh conversation when none).
   */
  const getScheduleContext = useCallback(async (): Promise<{ agentId: string; chatModelConfig: Record<string, unknown> }> => {
    const active = modelRef.current;
    if (!active) throw new Error("请先在模型设置中保存凭据");
    const targetId = viewingIdRef.current ?? startConversation("定时任务");
    const team = await ensureTeam(targetId);
    return {
      agentId: team.agent_id,
      chatModelConfig: { type: active.model_type, credential_id: active.credential_id, model: active.model, parameters: {} },
    };
  }, [ensureTeam, startConversation]);

  const confirmToolCall = useCallback(async (confirm: PendingConfirm, approved: boolean) => {
    const conversationId = viewingIdRef.current;
    if (!conversationId) return;
    const runtime = runtimesRef.current.get(conversationId);
    const pointer = runtime?.team;
    if (!runtime || !pointer) return;
    const confirmResults = confirm.toolCalls.map((tool_call) => ({ confirmed: approved, tool_call }));
    await agentApi.confirm(pointer, confirm.replyId, confirmResults);
    const card = runtime.tasks.get(confirm.workerSessionId);
    if (card) {
      card.confirm = undefined;
      if (card.status === "confirm") card.status = "working";
      scheduleFlush(conversationId);
    }
  }, [scheduleFlush]);

  /**
   * Interrupt a conversation's in-progress run: the leader session plus every
   * worker session. The backend interrupt is idempotent (idle sessions no-op),
   * and the resulting REPLY_END(INTERRUPTED) events flip the running marker /
   * card state through the normal SSE path. Defaults to the viewed
   * conversation (the stop button only shows there).
   */
  const stopTask = useCallback(async (conversationId?: string) => {
    const targetId = conversationId ?? viewingIdRef.current;
    if (!targetId) return;
    const runtime = runtimesRef.current.get(targetId);
    const pointer = runtime?.team ?? teamsRef.current.get(targetId) ?? null;
    if (!pointer) return;
    let workers = (runtime?.members ?? []).filter((member) => member.agent_id && member.session_id);
    if (workers.length === 0) {
      // Detached runtime without a cached roster — fetch it once so worker
      // sessions get interrupted too, not just the leader.
      try {
        const sessionData = await request<RosterResponse>(`/sessions/?agent_id=${pointer.agent_id}`);
        const entry = sessionData.sessions.find((item) => item.session?.id === pointer.session_id);
        workers = (entry?.team?.members ?? [])
          .filter((member) => member.agent?.id && member.session_id)
          .map((member) => ({ name: "", role: "", agent_id: member.agent!.id, session_id: member.session_id! }));
      } catch {
        // Roster unavailable — interrupting the leader alone still stops the run.
      }
    }
    const targets = [
      { agentId: pointer.agent_id, sessionId: pointer.session_id },
      ...workers.map((member) => ({ agentId: member.agent_id!, sessionId: member.session_id! })),
    ];
    await Promise.allSettled(targets.map((t) => agentApi.interrupt(t.agentId, t.sessionId)));
    window.setTimeout(() => void refreshRoster(targetId), 800);
  }, [refreshRoster]);

  /**
   * Show the welcome screen for a fresh conversation. The previously viewed
   * conversation only detaches its streams — its buffers stay in memory and
   * any running task keeps executing in the background.
   */
  const newConversation = useCallback(async () => {
    const current = viewingIdRef.current;
    if (current) {
      const runtime = runtimesRef.current.get(current);
      if (runtime) persistMessages(current, buildSnapshot(runtime));
      detachStreams(current);
    }
    viewingIdRef.current = null;
    setViewingId(null);
    writeLiveConversationId(null);
    setItems([]);
    setMembers([]);
    draftAccountRef.current = null;
    setSelectedAccountState(null);
  }, [buildSnapshot, detachStreams]);

  const resetTeam = useCallback(async () => {
    const conversationId = viewingIdRef.current;
    const pointer = conversationId ? teamsRef.current.get(conversationId) ?? null : null;
    if (conversationId) setConversationTeam(conversationId, null);
    await newConversation();
    if (pointer) await deleteTeamAgent(pointer);
  }, [deleteTeamAgent, newConversation, setConversationTeam]);

  /**
   * Switch the displayed conversation: detach the old one's streams (its
   * buffers and any running task survive), then attach the new one's streams
   * so the server-side replay log rebuilds any in-flight progress.
   */
  const selectConversation = useCallback((id: string) => {
    const current = viewingIdRef.current;
    if (id === current) {
      // Re-selecting the current conversation: recover the display from the
      // runtime buffer (or the archive if no runtime exists yet).
      const runtime = runtimesRef.current.get(id);
      setItems(runtime ? buildSnapshot(runtime) : loadMessages(id) ?? []);
      return;
    }
    if (current) {
      const previous = runtimesRef.current.get(current);
      if (previous) persistMessages(current, buildSnapshot(previous));
      detachStreams(current);
    }
    viewingIdRef.current = id;
    setViewingId(id);
    writeLiveConversationId(id);
    const runtime = getRuntime(id);
    runtime.team = teamsRef.current.get(id) ?? null;
    setItems(buildSnapshot(runtime));
    setMembers(runtime.members);
    setSelectedAccountState(accountBindingsRef.current.get(id) ?? null);
    if (runtime.team) attachStreams(id);
  }, [attachStreams, buildSnapshot, detachStreams, getRuntime]);

  /** Delete a conversation plus its own backend team and stored archive. */
  const deleteConversation = useCallback(async (id: string) => {
    detachStreams(id);
    runtimesRef.current.delete(id);
    setRunningFor(id, false);
    if (viewingIdRef.current === id) {
      viewingIdRef.current = null;
      setViewingId(null);
      writeLiveConversationId(null);
      setItems([]);
      setMembers([]);
      setSelectedAccountState(null);
    }
    accountBindingsRef.current.delete(id);
    const teamPointer = teamsRef.current.get(id) ?? null;
    teamsRef.current.delete(id);
    if (teamPointer) await deleteTeamAgent(teamPointer);
    removeConversation(id);
    setConversations((prev) => {
      const next = prev.filter((item) => item.id !== id);
      saveConversations(next);
      return next;
    });
  }, [deleteTeamAgent, detachStreams, setRunningFor]);

  /** Toggle the pinned state of a conversation. */
  const pinConversation = useCallback((id: string) => {
    setConversations((prev) => {
      const next = prev.map((item) =>
        item.id === id ? { ...item, pinned: !item.pinned } : item,
      );
      saveConversations(next);
      return next;
    });
  }, []);

  /** Rename a conversation title. */
  const renameConversation = useCallback((id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setConversations((prev) => {
      const next = prev.map((item) =>
        item.id === id ? { ...item, title: trimmed } : item,
      );
      saveConversations(next);
      return next;
    });
  }, []);

  useEffect(() => {
    resetPollutedArtifactMappings();
    void operationsApi.teamConfig().then((value) => {
      configRef.current = value;
      setConfig(value);
    }).catch(() => undefined);
    void request<{ redis_mode: string }>("/ready").then(() => setRuntimeMode("本地服务 · embedded")).catch(() => setRuntimeMode("服务未连接"));
    refreshArtifacts();
    void refreshAccounts();
    const runtimes = runtimesRef.current;
    return () => {
      for (const runtime of runtimes.values()) {
        runtime.controller?.abort();
        runtime.controller = null;
        if (runtime.rosterTimer !== null) {
          window.clearTimeout(runtime.rosterTimer);
          runtime.rosterTimer = null;
        }
      }
    };
  }, [refreshAccounts, refreshArtifacts]);

  useEffect(() => {
    let active = true;
    void (async () => {
      // Populate the per-conversation team registry from persisted meta.
      for (const conv of loadConversations()) {
        if (conv.team) teamsRef.current.set(conv.id, conv.team);
        if (conv.kb) kbsRef.current.set(conv.id, conv.kb.id);
        if (conv.account) accountBindingsRef.current.set(conv.id, conv.account);
      }
      const storedViewedId = readLiveConversationId();
      // Legacy migration: a global team pointer predating per-conversation
      // isolation belongs to the last viewed conversation.
      const legacyTeam = readMigrated<TeamPointer>(TEAM_KEY, LEGACY_TEAM_KEY);
      if (legacyTeam) {
        writeStored(TEAM_KEY, null);
        if (storedViewedId && !teamsRef.current.has(storedViewedId)) {
          setConversationTeam(storedViewedId, legacyTeam);
        }
      }
      const initialId = storedViewedId ?? loadConversations()[0]?.id ?? null;
      if (!active) return;
      if (initialId) {
        viewingIdRef.current = initialId;
        setViewingId(initialId);
        writeLiveConversationId(initialId);
        setSelectedAccountState(accountBindingsRef.current.get(initialId) ?? null);
        const runtime = getRuntime(initialId);
        setItems(buildSnapshot(runtime));
        // Validate the viewed conversation's pointer, then attach streams so
        // a reload resumes real-time progress via the replay log.
        const pointer = teamsRef.current.get(initialId);
        if (pointer) {
          let alive = false;
          try {
            const result = await request<RosterResponse>(`/sessions/?agent_id=${pointer.agent_id}`);
            alive = result.sessions.some((item) => item.session?.id === pointer.session_id);
          } catch {
            alive = false;
          }
          if (!active) return;
          if (alive) {
            runtime.team = pointer;
            attachStreams(initialId);
          } else {
            // Stale pointer (backend restarted) — next send rebuilds the team.
            setConversationTeam(initialId, null);
          }
        }
      }
      // Light up running markers for every other conversation with a live
      // team; the background poll keeps them fresh afterwards.
      for (const [convId, pointer] of teamsRef.current.entries()) {
        if (convId === initialId) continue;
        void request<RosterResponse>(`/sessions/?agent_id=${pointer.agent_id}`)
          .then((result) => {
            const entry = result.sessions.find((item) => item.session?.id === pointer.session_id);
            if (active && entry?.is_running) setRunningFor(convId, true);
          })
          .catch(() => undefined);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll background (non-viewed) running conversations so their sidebar
  // markers clear when the task finishes and their artifacts get attributed.
  useEffect(() => {
    const backgroundIds = [...runningIds].filter((id) => id !== viewingId);
    if (backgroundIds.length === 0) return;
    const timer = window.setInterval(() => {
      for (const convId of backgroundIds) {
        const pointer = teamsRef.current.get(convId);
        if (!pointer) {
          setRunningFor(convId, false);
          continue;
        }
        void request<RosterResponse>(`/sessions/?agent_id=${pointer.agent_id}`)
          .then((result) => {
            const entry = result.sessions.find((item) => item.session?.id === pointer.session_id);
            if (!entry?.is_running) {
              setRunningFor(convId, false);
              refreshArtifacts(convId);
            }
          })
          .catch(() => undefined);
      }
    }, BACKGROUND_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshArtifacts, runningIds, setRunningFor, viewingId]);

  // Artifacts filtered to the currently viewed conversation.
  const viewingArtifacts = useMemo(() => {
    if (!viewingId) return [];
    const ids = new Set(loadConversationArtifactIds(viewingId));
    return artifacts.filter((a) => ids.has(a.id));
  }, [artifacts, viewingId]);

  /** Whether the currently viewed conversation is executing a task. */
  const running = viewingId !== null && runningIds.has(viewingId);

  /** RAG attachment statuses for the viewed conversation. */
  const attachments = viewingId ? attachmentsMap[viewingId] ?? [] : [];

  return {
    model,
    setModel,
    config,
    members,
    items,
    running,
    runningIds,
    runtimeMode,
    artifacts,
    viewingArtifacts,
    conversations,
    viewingId,
    accounts,
    refreshAccounts,
    selectedAccount,
    setSelectedAccount,
    sendMessage,
    continueRun,
    submitExternal,
    attachFiles,
    attachments,
    getScheduleContext,
    resetTeam,
    newConversation,
    selectConversation,
    deleteConversation,
    pinConversation,
    renameConversation,
    refreshRoster,
    refreshArtifacts,
    confirmToolCall,
    stopTask,
  };
}
