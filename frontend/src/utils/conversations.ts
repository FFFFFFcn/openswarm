import type { ChatHint, ChatImage, ChatItem, ConversationMeta } from "@/api/types";
import { readStored, writeStored } from "./storage";

const CONVERSATIONS_KEY = "openswarm-conversations";
const LIVE_CONVERSATION_KEY = "openswarm-live-conversation";
const MESSAGES_PREFIX = "openswarm-conv-messages:";
const ARTIFACTS_PREFIX = "openswarm-conv-artifacts:";
const MAX_CONVERSATIONS = 30;

export function loadConversations(): ConversationMeta[] {
  const list = readStored<ConversationMeta[]>(CONVERSATIONS_KEY) ?? [];
  if (!Array.isArray(list)) return [];
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveConversations(list: ConversationMeta[]): void {
  writeStored(CONVERSATIONS_KEY, list.slice(0, MAX_CONVERSATIONS));
}

/**
 * Last *viewed* conversation, restored after a page reload. (The storage key
 * predates multi-session concurrency, when it identified the single "live"
 * conversation — kept for backwards compatibility with existing data.)
 */
export function readLiveConversationId(): string | null {
  return readStored<string>(LIVE_CONVERSATION_KEY);
}

export function writeLiveConversationId(id: string | null): void {
  writeStored(LIVE_CONVERSATION_KEY, id);
}

/** Keep only remote (http/https) images in an archive — base64 `data:` URLs
 * can be megabytes each and would blow the localStorage quota. */
function archiveImages(images: ChatImage[] | undefined): ChatImage[] | undefined {
  const kept = (images ?? []).filter((image) => !image.src.startsWith("data:"));
  return kept.length ? kept : undefined;
}

function archiveHints(hints: ChatHint[] | undefined): ChatHint[] | undefined {
  if (!hints?.length) return undefined;
  return hints.slice(-10).map((hint) => ({ ...hint, text: hint.text.slice(0, 800), images: archiveImages(hint.images) }));
}

/**
 * Strip transient/heavy fields from a snapshot before archiving so a
 * conversation stays small in localStorage. Narration, thinking, tool output
 * and task summaries are truncated; base64 images and the live-only `confirm`
 * payload are dropped.
 */
function toArchive(items: ChatItem[]): ChatItem[] {
  const result: ChatItem[] = [];
  for (const item of items) {
    if (item.kind !== "task") {
      result.push({
        ...item,
        streaming: false,
        thinking: item.thinking ? item.thinking.slice(-2000) : undefined,
        images: archiveImages(item.images),
        hints: archiveHints(item.hints),
      });
      continue;
    }
    const task = item.task;
    result.push({
      ...item,
      task: {
        ...task,
        narration: task.narration.slice(-1500),
        summary: task.summary.slice(0, 500),
        // Keep the tail of the work log (most recent activity) and cap each
        // entry so an archived conversation stays small.
        entries: (task.entries ?? [])
          .slice(-60)
          .map((entry) => {
            switch (entry.kind) {
              case "text":
              case "thinking":
                return { ...entry, text: entry.text.slice(-800) };
              case "hint":
                return { ...entry, text: entry.text.slice(0, 800), images: archiveImages(entry.images) };
              case "image":
                // Base64 stream images are display-only; drop them from the archive.
                return entry.image.src.startsWith("data:") ? null : entry;
              case "tool":
                return { ...entry, output: entry.output ? entry.output.slice(-1500) : undefined, images: archiveImages(entry.images) };
              default:
                return entry;
            }
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
        confirm: undefined,
      },
    });
  }
  return result;
}

export function loadMessages(id: string): ChatItem[] | null {
  const items = readStored<ChatItem[]>(`${MESSAGES_PREFIX}${id}`);
  return Array.isArray(items) ? items : null;
}

export function persistMessages(id: string, items: ChatItem[]): void {
  try {
    // Guard: never overwrite an existing non-empty archive with an empty
    // snapshot (can happen when in-memory refs were lost after a hot reload).
    if (items.length === 0) {
      const existing = loadMessages(id);
      if (existing && existing.length > 0) return;
    }
    writeStored(`${MESSAGES_PREFIX}${id}`, toArchive(items));
  } catch {
    // localStorage may be full — drop the archive rather than crash the app.
  }
}

/** Remove a conversation's metadata and archived messages. */
export function removeConversation(id: string): void {
  const list = loadConversations().filter((item) => item.id !== id);
  saveConversations(list);
  writeStored(`${MESSAGES_PREFIX}${id}`, null);
}

/** Derive a short conversation title from the first user message. */
export function conversationTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 22 ? `${trimmed.slice(0, 22)}…` : trimmed || "新对话";
}

/** Compact relative timestamp for the sidebar, e.g. "5 分钟前" / "昨天" / "7/20". */
export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  if (diff < minute) return "刚刚";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  const day = 24 * 60 * minute;
  if (diff < day) return `${Math.floor(diff / (60 * minute))} 小时前`;
  const date = new Date(timestamp);
  const today = new Date();
  const isYesterday =
    diff < 2 * day && date.getDate() !== today.getDate();
  if (isYesterday) return "昨天";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** Date group label for a timestamp: "今天" / "昨天" / "7月20日". */
export function dateGroupLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (dayStart >= startOfToday) return "今天";
  if (dayStart >= startOfYesterday) return "昨天";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export interface DateGroup {
  label: string;
  items: ConversationMeta[];
}

/** Group sorted conversations by calendar date (今天 → 昨天 → earlier). */
export function groupByDate(conversations: ConversationMeta[]): DateGroup[] {
  const groups: DateGroup[] = [];
  for (const conv of conversations) {
    const label = dateGroupLabel(conv.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.items.push(conv);
    } else {
      groups.push({ label, items: [conv] });
    }
  }
  return groups;
}

/** Load artifact ids associated with a conversation. */
export function loadConversationArtifactIds(conversationId: string): string[] {
  return readStored<string[]>(`${ARTIFACTS_PREFIX}${conversationId}`) ?? [];
}

/** Persist artifact ids for a conversation. */
export function saveConversationArtifactIds(conversationId: string, ids: string[]): void {
  writeStored(`${ARTIFACTS_PREFIX}${conversationId}`, ids);
}

const ARTIFACTS_CLEANUP_KEY = "openswarm-conv-artifacts-reset";

/**
 * One-time cleanup: an earlier build bulk-attributed the entire pre-existing
 * server artifact library to whichever conversation happened to be live on
 * first load. Clear those polluted conversation→artifact mappings once so a
 * conversation only accrues artifacts it actually produces from now on. The
 * global 资产库 (server-side files) is unaffected.
 */
export function resetPollutedArtifactMappings(): void {
  if (readStored<boolean>(ARTIFACTS_CLEANUP_KEY)) return;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith(ARTIFACTS_PREFIX)) keys.push(key);
  }
  keys.forEach((key) => localStorage.removeItem(key));
  writeStored(ARTIFACTS_CLEANUP_KEY, true);
}
