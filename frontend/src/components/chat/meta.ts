import type { TaskStatus } from "@/api/types";

/** Display names for the editorial sub-agent roles. */
export const roleNames: Record<string, string> = {
  insight_analyst: "洞察分析",
  account_planner: "起号策划",
  account_benchmark_analyst: "账号对标分析",
  topic_planner: "选题策划",
  content_creator: "内容创作",
};

/**
 * Status pill metadata. Monochrome palette — only the error state keeps a
 * semantic red (necessary signal); everything else is black/white/gray.
 */
export const statusMeta: Record<
  TaskStatus,
  { label: string; spin: boolean; className: string }
> = {
  starting: {
    label: "准备中",
    spin: true,
    className: "bg-muted text-ink-muted",
  },
  working: {
    label: "工作中",
    spin: true,
    className: "bg-foreground text-background",
  },
  confirm: {
    label: "待授权",
    spin: false,
    className: "bg-muted text-foreground",
  },
  done: {
    label: "已完成",
    spin: false,
    className: "bg-muted text-ink-secondary",
  },
  error: {
    label: "出错",
    spin: false,
    className: "bg-destructive/10 text-destructive",
  },
};

/** Labels for abnormal REPLY_END reasons, shown as bubble/card badges. */
export const finishReasonLabels: Record<string, string> = {
  interrupted: "已中断",
  exceed_max_iters: "已达迭代上限",
};

/** Compact token count: 850 → "850", 12345 → "12.3k". */
export function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/**
 * Chinese display names for tool/action identifiers surfaced in the UI.
 * Unknown names fall back to the raw identifier via `toolDisplayName`.
 */
export const toolNames: Record<string, string> = {
  // runtime built-ins
  AgentCreate: "创建协作成员",
  AgentInvite: "邀请协作成员",
  TeamCreate: "组建团队",
  TeamSay: "团队汇报",
  TaskCreate: "创建任务",
  TaskUpdate: "更新任务",
  TaskList: "查看任务列表",
  Skill: "调用技能",
  reset_tools: "重置工具集",
  reset_equipped_tools: "重置工具集",
  // editorial workspace tools
  get_account_context: "读取账号档案",
  save_account_strategy: "保存起号策略",
  list_topics: "查看选题列表",
  save_topic: "保存选题卡",
  create_xiaohongshu_draft: "创建笔记草稿",
  list_drafts: "查看草稿列表",
  check_xiaohongshu_compliance: "内容合规预检",
  // external data tools
  search_xiaohongshu_hot_notes: "搜索爆款笔记",
  search_xiaohongshu_similar_accounts: "查询对标账号",
  analyze_xiaohongshu_titles: "标题趋势分析",
  design_xiaohongshu_cover: "封面灵感分析",
};

/** Map an English tool/action name to its Chinese label (fallback: raw name). */
export function toolDisplayName(name: string): string {
  return toolNames[name] ?? name;
}

/** Render a tool call's JSON `input` string as a compact, truncated summary. */
export function formatToolInput(input: string): string {
  let text: string;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    text = Object.entries(parsed)
      .map(
        ([key, value]) =>
          `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
      )
      .join("，");
  } catch {
    text = input;
  }
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}
