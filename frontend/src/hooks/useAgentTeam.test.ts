import { describe, expect, it } from "vitest";
import { CUSTOM_CONFIRM_RESULT, CUSTOM_REQUIRE_CONFIRM, parseSseEvent } from "../utils/sse";

const SID = "leader-session";

function block(json: string): string {
  return `data: ${json}`;
}

describe("parseSseEvent", () => {
  it("parses reply lifecycle events", () => {
    expect(parseSseEvent(SID, block('{"type":"REPLY_START","reply_id":"r1","name":"主理人","role":"assistant"}'))).toEqual({ type: "REPLY_START", sessionId: SID, replyId: "r1", name: "主理人" });
    expect(parseSseEvent(SID, block('{"type":"REPLY_END","reply_id":"r1","finished_reason":"stop"}'))).toEqual({ type: "REPLY_END", sessionId: SID, replyId: "r1", finishedReason: "stop" });
  });

  it("parses text and thinking deltas", () => {
    expect(parseSseEvent(SID, block('{"type":"TEXT_BLOCK_DELTA","reply_id":"r1","block_id":"b1","delta":"你好"}'))).toEqual({ type: "TEXT_BLOCK_DELTA", sessionId: SID, replyId: "r1", blockId: "b1", delta: "你好" });
    expect(parseSseEvent(SID, block('{"type":"THINKING_BLOCK_DELTA","reply_id":"r1","block_id":"b2","delta":"思考"}'))).toEqual({ type: "THINKING_BLOCK_DELTA", sessionId: SID, replyId: "r1", blockId: "b2", delta: "思考" });
  });

  it("parses tool call start/delta/end", () => {
    expect(parseSseEvent(SID, block('{"type":"TOOL_CALL_START","reply_id":"r1","tool_call_id":"t1","tool_call_name":"AgentCreate"}'))).toEqual({ type: "TOOL_CALL_START", sessionId: SID, replyId: "r1", toolCallId: "t1", toolCallName: "AgentCreate" });
    expect(parseSseEvent(SID, block('{"type":"TOOL_CALL_DELTA","reply_id":"r1","tool_call_id":"t1","delta":"{\\"name\\""}'))).toEqual({ type: "TOOL_CALL_DELTA", sessionId: SID, replyId: "r1", toolCallId: "t1", delta: '{"name"' });
    expect(parseSseEvent(SID, block('{"type":"TOOL_CALL_END","reply_id":"r1","tool_call_id":"t1"}'))).toEqual({ type: "TOOL_CALL_END", sessionId: SID, replyId: "r1", toolCallId: "t1" });
  });

  it("parses tool result start/end", () => {
    expect(parseSseEvent(SID, block('{"type":"TOOL_RESULT_START","reply_id":"r1","tool_call_id":"t1","tool_call_name":"search_xiaohongshu_hot_notes"}'))).toEqual({ type: "TOOL_RESULT_START", sessionId: SID, replyId: "r1", toolCallId: "t1", toolCallName: "search_xiaohongshu_hot_notes" });
    expect(parseSseEvent(SID, block('{"type":"TOOL_RESULT_END","reply_id":"r1","tool_call_id":"t1","state":"success","metadata":{}}'))).toEqual({ type: "TOOL_RESULT_END", sessionId: SID, replyId: "r1", toolCallId: "t1", state: "success" });
  });

  it("parses the two HITL custom events", () => {
    const requireConfirm = parseSseEvent(SID, block(`{"type":"CUSTOM","name":"${CUSTOM_REQUIRE_CONFIRM}","value":{"worker_session_id":"w1","reply_id":"wr1","worker_agent_name":"洞察","event":{"tool_calls":[]}}}`));
    expect(requireConfirm?.type).toBe("CUSTOM");
    if (requireConfirm?.type === "CUSTOM") {
      expect(requireConfirm.name).toBe(CUSTOM_REQUIRE_CONFIRM);
      expect(requireConfirm.value.worker_session_id).toBe("w1");
    }
    const confirmResult = parseSseEvent(SID, block(`{"type":"CUSTOM","name":"${CUSTOM_CONFIRM_RESULT}","value":{"worker_session_id":"w1","reply_id":"wr1"}}`));
    expect(confirmResult?.type).toBe("CUSTOM");
  });

  it("accumulates AgentCreate argument deltas into parseable JSON", () => {
    const fragments = ['{"name":"洞察分析', '员","subagent_type":"insight_analyst","prompt":"分析爆款"}'];
    let acc = "";
    for (const fragment of fragments) {
      const parsed = parseSseEvent(SID, block(JSON.stringify({ type: "TOOL_CALL_DELTA", reply_id: "r1", tool_call_id: "t1", delta: fragment })));
      if (parsed?.type === "TOOL_CALL_DELTA") acc += parsed.delta;
    }
    expect(JSON.parse(acc)).toEqual({ name: "洞察分析员", subagent_type: "insight_analyst", prompt: "分析爆款" });
  });

  it("parses model call, data block, hint and tool output events", () => {
    expect(parseSseEvent(SID, block('{"type":"MODEL_CALL_START","reply_id":"r1","model_name":"glm-4.7"}'))).toEqual({ type: "MODEL_CALL_START", sessionId: SID, replyId: "r1", modelName: "glm-4.7" });
    expect(parseSseEvent(SID, block('{"type":"MODEL_CALL_END","reply_id":"r1","input_tokens":120,"output_tokens":45}'))).toEqual({ type: "MODEL_CALL_END", sessionId: SID, replyId: "r1", inputTokens: 120, outputTokens: 45 });
    expect(parseSseEvent(SID, block('{"type":"DATA_BLOCK_DELTA","reply_id":"r1","block_id":"d1","data":"aGVsbG8=","media_type":"image/png"}'))).toEqual({ type: "DATA_BLOCK_DELTA", sessionId: SID, replyId: "r1", blockId: "d1", data: "aGVsbG8=", mediaType: "image/png" });
    expect(parseSseEvent(SID, block('{"type":"DATA_BLOCK_END","reply_id":"r1","block_id":"d1"}'))).toEqual({ type: "DATA_BLOCK_END", sessionId: SID, replyId: "r1", blockId: "d1" });
    expect(parseSseEvent(SID, block('{"type":"TOOL_RESULT_TEXT_DELTA","reply_id":"r1","tool_call_id":"t1","delta":"结果"}'))).toEqual({ type: "TOOL_RESULT_TEXT_DELTA", sessionId: SID, replyId: "r1", toolCallId: "t1", delta: "结果" });
    expect(parseSseEvent(SID, block('{"type":"TOOL_RESULT_DATA_DELTA","reply_id":"r1","tool_call_id":"t1","block_id":"d2","media_type":"image/png","url":"https://x/y.png"}'))).toEqual({ type: "TOOL_RESULT_DATA_DELTA", sessionId: SID, replyId: "r1", toolCallId: "t1", blockId: "d2", mediaType: "image/png", data: undefined, url: "https://x/y.png" });
    expect(parseSseEvent(SID, block('{"type":"EXCEED_MAX_ITERS","reply_id":"r1","name":"主理人"}'))).toEqual({ type: "EXCEED_MAX_ITERS", sessionId: SID, replyId: "r1", name: "主理人" });
  });

  it("flattens hint blocks into text plus images", () => {
    const plain = parseSseEvent(SID, block('{"type":"HINT_BLOCK","reply_id":"r1","block_id":"h1","source":"alice","hint":"请优先处理"}'));
    expect(plain).toEqual({ type: "HINT_BLOCK", sessionId: SID, replyId: "r1", blockId: "h1", source: "alice", text: "请优先处理", images: [] });
    const multimodal = parseSseEvent(SID, block('{"type":"HINT_BLOCK","reply_id":"r1","block_id":"h2","hint":[{"type":"text","text":"图表"},{"type":"data","id":"db1","source":{"type":"url","url":"https://x/chart.png","media_type":"image/png"}}]}'));
    expect(multimodal?.type).toBe("HINT_BLOCK");
    if (multimodal?.type === "HINT_BLOCK") {
      expect(multimodal.text).toBe("图表");
      expect(multimodal.images).toEqual([{ blockId: "db1", mediaType: "image/png", src: "https://x/chart.png" }]);
    }
  });

  it("parses roster push custom events", () => {
    const teamUpdated = parseSseEvent(SID, block('{"type":"CUSTOM","name":"team_updated","value":{}}'));
    expect(teamUpdated?.type).toBe("CUSTOM");
    if (teamUpdated?.type === "CUSTOM") expect(teamUpdated.name).toBe("team_updated");
  });

  it("ignores malformed JSON, unknown types, and unknown custom events", () => {
    expect(parseSseEvent(SID, "data: not-json")).toBeNull();
    expect(parseSseEvent(SID, block('{"event":"heartbeat"}'))).toBeNull();
    expect(parseSseEvent(SID, block('{"type":"TOOL_RESULT_TEXT_DELTA","delta":"INTERNAL","text":"INTERNAL"}'))).toBeNull();
    expect(parseSseEvent(SID, block('{"type":"CUSTOM","name":"some_internal_event","value":{}}'))).toBeNull();
    expect(parseSseEvent(SID, "event: ping")).toBeNull();
  });
});
