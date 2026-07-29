import type { ChatImage, SseEvent, ToolCallBlock } from "../api/types";

/** CUSTOM event names projected onto the leader stream for subagent HITL. */
export const CUSTOM_REQUIRE_CONFIRM = "subagent_require_user_confirm";
export const CUSTOM_CONFIRM_RESULT = "subagent_user_confirm_result";
/** CUSTOM notifications about live team/task state (runtime CustomEvent). */
export const CUSTOM_TEAM_UPDATED = "team_updated";
export const CUSTOM_STATE_UPDATED = "state_updated";

const KNOWN_CUSTOM_NAMES = new Set([
  CUSTOM_REQUIRE_CONFIRM,
  CUSTOM_CONFIRM_RESULT,
  CUSTOM_TEAM_UPDATED,
  CUSTOM_STATE_UPDATED,
]);

const MAX_DATA_LINE = 1_000_000;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Flatten a HintBlock's `hint` payload (plain string, or a list of
 * TextBlock / DataBlock) into display text plus inline images. Base64
 * data sources become `data:` URLs; URL sources pass through.
 */
function flattenHint(hint: unknown): { text: string; images: ChatImage[] } {
  if (typeof hint === "string") return { text: hint, images: [] };
  const texts: string[] = [];
  const images: ChatImage[] = [];
  if (Array.isArray(hint)) {
    for (const part of hint) {
      if (!part || typeof part !== "object") continue;
      const blockPart = part as Record<string, unknown>;
      if (blockPart.type === "text" && typeof blockPart.text === "string") {
        texts.push(blockPart.text);
      } else if (blockPart.type === "data" && blockPart.source && typeof blockPart.source === "object") {
        const source = blockPart.source as Record<string, unknown>;
        const mediaType = str(source.media_type) ?? "application/octet-stream";
        const blockId = str(blockPart.id) ?? crypto.randomUUID();
        if (source.type === "url" && typeof source.url === "string") {
          images.push({ blockId, mediaType, src: source.url });
        } else if (source.type === "base64" && typeof source.data === "string") {
          images.push({ blockId, mediaType, src: `data:${mediaType};base64,${source.data}` });
        }
      }
    }
  }
  return { text: texts.join("\n"), images };
}

/**
 * Parse one SSE block (the text between blank lines) into a normalized
 * `SseEvent`. Every event is tagged with the `sessionId` of the stream it
 * was read from so the reducer can route leader vs. worker traffic.
 *
 * Unknown event types, malformed JSON, and non-HITL custom events return
 * `null`. Tool-call argument DELTAs are passed through untouched — the
 * caller accumulates them and parses the full JSON on TOOL_CALL_END.
 */
export function parseSseEvent(sessionId: string, block: string): SseEvent | null {
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (payload.length > MAX_DATA_LINE) return null;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }

  const replyId = str(event.reply_id);
  switch (event.type) {
    case "REPLY_START":
      if (replyId === null) return null;
      return { type: "REPLY_START", sessionId, replyId, name: str(event.name) ?? "智能体" };
    case "REPLY_END":
      if (replyId === null) return null;
      return { type: "REPLY_END", sessionId, replyId, finishedReason: str(event.finished_reason) ?? "" };
    case "TEXT_BLOCK_DELTA": {
      const delta = str(event.delta);
      if (replyId === null || str(event.block_id) === null || delta === null) return null;
      return { type: "TEXT_BLOCK_DELTA", sessionId, replyId, blockId: event.block_id as string, delta };
    }
    case "THINKING_BLOCK_DELTA": {
      const delta = str(event.delta);
      if (replyId === null || str(event.block_id) === null || delta === null) return null;
      return { type: "THINKING_BLOCK_DELTA", sessionId, replyId, blockId: event.block_id as string, delta };
    }
    case "DATA_BLOCK_DELTA": {
      const blockId = str(event.block_id);
      const data = str(event.data);
      if (replyId === null || blockId === null || data === null) return null;
      return { type: "DATA_BLOCK_DELTA", sessionId, replyId, blockId, data, mediaType: str(event.media_type) ?? "application/octet-stream" };
    }
    case "DATA_BLOCK_END": {
      const blockId = str(event.block_id);
      if (replyId === null || blockId === null) return null;
      return { type: "DATA_BLOCK_END", sessionId, replyId, blockId };
    }
    case "HINT_BLOCK": {
      const blockId = str(event.block_id);
      if (replyId === null || blockId === null) return null;
      const { text, images } = flattenHint(event.hint);
      if (!text && images.length === 0) return null;
      return { type: "HINT_BLOCK", sessionId, replyId, blockId, source: str(event.source) ?? undefined, text, images };
    }
    case "MODEL_CALL_START": {
      if (replyId === null) return null;
      return { type: "MODEL_CALL_START", sessionId, replyId, modelName: str(event.model_name) ?? "" };
    }
    case "MODEL_CALL_END": {
      if (replyId === null) return null;
      return { type: "MODEL_CALL_END", sessionId, replyId, inputTokens: num(event.input_tokens), outputTokens: num(event.output_tokens) };
    }
    case "TOOL_CALL_START": {
      const toolCallId = str(event.tool_call_id);
      if (replyId === null || toolCallId === null) return null;
      return { type: "TOOL_CALL_START", sessionId, replyId, toolCallId, toolCallName: str(event.tool_call_name) ?? "tool" };
    }
    case "TOOL_CALL_DELTA": {
      const toolCallId = str(event.tool_call_id);
      const delta = str(event.delta);
      if (replyId === null || toolCallId === null || delta === null) return null;
      return { type: "TOOL_CALL_DELTA", sessionId, replyId, toolCallId, delta };
    }
    case "TOOL_CALL_END": {
      const toolCallId = str(event.tool_call_id);
      if (replyId === null || toolCallId === null) return null;
      return { type: "TOOL_CALL_END", sessionId, replyId, toolCallId };
    }
    case "TOOL_RESULT_START": {
      const toolCallId = str(event.tool_call_id);
      if (replyId === null || toolCallId === null) return null;
      return { type: "TOOL_RESULT_START", sessionId, replyId, toolCallId, toolCallName: str(event.tool_call_name) ?? "tool" };
    }
    case "TOOL_RESULT_TEXT_DELTA": {
      const toolCallId = str(event.tool_call_id);
      const delta = str(event.delta);
      if (replyId === null || toolCallId === null || delta === null) return null;
      return { type: "TOOL_RESULT_TEXT_DELTA", sessionId, replyId, toolCallId, delta };
    }
    case "TOOL_RESULT_DATA_DELTA": {
      const toolCallId = str(event.tool_call_id);
      const blockId = str(event.block_id);
      if (replyId === null || toolCallId === null || blockId === null) return null;
      const data = str(event.data) ?? undefined;
      const url = str(event.url) ?? undefined;
      if (!data && !url) return null;
      return { type: "TOOL_RESULT_DATA_DELTA", sessionId, replyId, toolCallId, blockId, mediaType: str(event.media_type) ?? "application/octet-stream", data, url };
    }
    case "TOOL_RESULT_END": {
      const toolCallId = str(event.tool_call_id);
      if (replyId === null || toolCallId === null) return null;
      return { type: "TOOL_RESULT_END", sessionId, replyId, toolCallId, state: str(event.state) ?? "" };
    }
    case "EXCEED_MAX_ITERS": {
      if (replyId === null) return null;
      return { type: "EXCEED_MAX_ITERS", sessionId, replyId, name: str(event.name) ?? "" };
    }
    case "REQUIRE_EXTERNAL_EXECUTION": {
      if (replyId === null || !Array.isArray(event.tool_calls)) return null;
      const toolCalls: ToolCallBlock[] = [];
      for (const raw of event.tool_calls) {
        if (!raw || typeof raw !== "object") continue;
        const call = raw as Record<string, unknown>;
        const id = str(call.id);
        const name = str(call.name);
        if (id === null || name === null) continue;
        // `input` may arrive as an object or a JSON string; normalize to string.
        const input = typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {});
        toolCalls.push({ type: "tool_call", id, name, input });
      }
      if (toolCalls.length === 0) return null;
      return { type: "REQUIRE_EXTERNAL_EXECUTION", sessionId, replyId, toolCalls };
    }
    case "CUSTOM": {
      const name = str(event.name);
      if (name === null || !KNOWN_CUSTOM_NAMES.has(name)) return null;
      const value = event.value;
      if (!value || typeof value !== "object") return null;
      return { type: "CUSTOM", sessionId, name, value: value as Record<string, unknown> };
    }
    default:
      return null;
  }
}

/**
 * Consume an SSE endpoint, invoking `onEvent` for every parsed event.
 * Resolves when the stream closes; rejects on network failure or a
 * non-OK response (AbortError when cancelled via `signal`).
 */
export async function readSseStream(
  url: string,
  sessionId: string,
  onEvent: (event: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { headers: { "X-User-ID": "local-user" }, signal });
  if (!response.ok || !response.body) throw new Error("事件流连接失败");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const parsed = parseSseEvent(sessionId, block);
      if (parsed) onEvent(parsed);
    }
  }
}
