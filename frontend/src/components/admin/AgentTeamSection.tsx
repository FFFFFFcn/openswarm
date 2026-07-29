import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import {
  adminApi,
  formatDate,
  type AdminAgentRole,
  type AdminAgentTeam,
  type AdminRoleTool,
} from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ConfirmDeleteButton, SectionHeader } from "./shared";

/** Worker skill-directory name → Chinese role label. */
const ROLE_LABELS: Record<string, string> = {
  "insight-analyst": "洞察分析",
  "account-planner": "账号规划",
  "account-benchmark-analyst": "账号对标",
  "topic-planner": "选题策划",
  "content-creator": "内容创作",
};

const TOOL_KIND_LABELS: Record<AdminRoleTool["kind"], string> = {
  local: "本地业务",
  external_data: "外部数据",
  user_interaction: "用户交互",
};

/** Monospace scrollable block for prompts and SKILL.md content. */
function PromptBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-3 text-xs leading-relaxed text-ink-muted">
      {text || "（空）"}
    </pre>
  );
}

/** One collapsible role card: template info, tools, prompt and skill. */
function RoleCard({ role }: { role: AdminAgentRole }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg bg-card">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-accent/50"
        onClick={() => setOpen((prev) => !prev)}
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-ink-muted" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-ink-muted" />
        )}
        <span className="font-medium text-foreground">{role.label}</span>
        <code className="text-[11px] text-ink-faint">{role.key}</code>
        <Badge variant="secondary" className="text-[11px]">
          {role.kind === "leader" ? "主理人" : "worker"}
        </Badge>
        <span className="ml-auto shrink-0 text-xs text-ink-muted">
          {role.tools.length} 个业务工具
        </span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-border/60 px-4 py-3">
          {role.description && (
            <p className="text-xs text-ink-muted">{role.description}</p>
          )}
          <div>
            <p className="pb-1.5 text-xs font-medium text-ink-muted">
              业务工具（{role.tools.length}）
            </p>
            {role.tools.length ? (
              <div className="overflow-hidden rounded-md bg-background/60">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-[11px] text-ink-muted">
                      <th className="w-56 px-2.5 py-1.5 font-medium">名称</th>
                      <th className="px-2.5 py-1.5 font-medium">说明</th>
                      <th className="w-20 px-2.5 py-1.5 font-medium">权限</th>
                      <th className="w-20 px-2.5 py-1.5 font-medium">类型</th>
                    </tr>
                  </thead>
                  <tbody>
                    {role.tools.map((tool) => (
                      <tr key={tool.name} className="border-t border-border/40">
                        <td className="px-2.5 py-1.5">
                          <code className="text-foreground">{tool.name}</code>
                        </td>
                        <td className="px-2.5 py-1.5 text-ink-muted">
                          {tool.description}
                        </td>
                        <td className="px-2.5 py-1.5 text-ink-muted">
                          {tool.read_only ? "只读" : "可写"}
                        </td>
                        <td className="px-2.5 py-1.5 text-ink-muted">
                          {TOOL_KIND_LABELS[tool.kind] ?? tool.kind}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-ink-faint">无专属业务工具</p>
            )}
            {role.builtin_note && (
              <p className="pt-1.5 text-[11px] text-ink-faint">
                {role.builtin_note}
              </p>
            )}
          </div>
          <div>
            <p className="pb-1.5 text-xs font-medium text-ink-muted">
              系统提示词
            </p>
            <PromptBlock text={role.system_prompt} />
          </div>
          <div>
            <p className="pb-1.5 text-xs font-medium text-ink-muted">
              技能文件 <code className="text-[11px]">{role.skill_path}</code>
            </p>
            <PromptBlock text={role.skill} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Agent runtime management: health card, agent roster with
 * cascade deletion (two-step confirm), and the team list. Deleting a
 * leader dissolves its team and invalidates the matching conversation
 * in the main UI — the confirm copy warns about that.
 */
export function AgentTeamSection() {
  const [state, setState] = useState<AdminAgentTeam | null>(null);
  const [roles, setRoles] = useState<AdminAgentRole[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setConfirmingId(null);
    try {
      setState(await adminApi.agentTeam());
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Role configs are static per backend build — one fetch is enough.
    adminApi.agentTeamRoles().then(setRoles).catch(() => undefined);
  }, [refresh]);

  const handleDelete = async (id: string) => {
    if (confirmingId !== id) {
      setConfirmingId(id);
      return;
    }
    setBusyId(id);
    try {
      await adminApi.agentDelete(id);
      toast.success("智能体已删除，其团队与会话已级联清理");
      await refresh();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  };

  const runtime = state?.runtime;
  const agents = state?.agents ?? [];
  const teams = state?.teams ?? [];

  return (
    <div>
      <SectionHeader
        title="智能体团队"
        description="智能体运行时中的智能体、团队与连接状态；删除主理人会级联解散其团队。"
        actions={
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCwIcon
              className={cn("size-3.5", loading && "animate-spin")}
            />
            刷新
          </Button>
        }
      />

      {runtime && (
        <div className="mb-5 flex items-center gap-3 rounded-lg bg-card p-4 text-sm">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              runtime.available ? "bg-emerald-500" : "bg-red-500",
            )}
          />
          <div>
            <p className="text-foreground">
              运行时{runtime.available ? "连接正常" : "不可用"}
            </p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {runtime.redis_mode === "embedded"
                ? "内置内存模式——重启后端后智能体与会话即清空（凭据除外）。"
                : "外部 Redis 模式——数据随 Redis 持久化。"}
            </p>
          </div>
        </div>
      )}

      <p className="pb-2 text-xs font-medium text-ink-muted">智能体</p>
      {agents.length ? (
        <div className="overflow-hidden rounded-lg bg-card">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-xs text-ink-muted">
                <th className="px-3 py-2 font-medium">名称</th>
                <th className="w-36 px-3 py-2 font-medium">类型</th>
                <th className="w-20 px-3 py-2 font-medium">会话数</th>
                <th className="w-28 px-3 py-2 font-medium">创建时间</th>
                <th className="w-28 px-3 py-2 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <Fragment key={agent.id}>
                  <tr className="border-t border-border/60">
                    <td className="max-w-0 px-3 py-2 text-foreground">
                      <button
                        type="button"
                        className="flex w-full items-center gap-1.5 text-left"
                        onClick={() =>
                          setExpandedId(
                            expandedId === agent.id ? null : agent.id,
                          )
                        }
                      >
                        {expandedId === agent.id ? (
                          <ChevronDownIcon className="size-3.5 shrink-0 text-ink-muted" />
                        ) : (
                          <ChevronRightIcon className="size-3.5 shrink-0 text-ink-muted" />
                        )}
                        <span className="truncate">{agent.name}</span>
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="secondary" className="text-[11px]">
                        {agent.source === "team"
                          ? `团队成员 · ${agent.role ? ROLE_LABELS[agent.role] ?? agent.role : "未知角色"}`
                          : "主理人/自建"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-ink-muted">
                      {agent.sessions}
                    </td>
                    <td className="px-3 py-2 text-ink-muted">
                      {formatDate(agent.created_at)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <ConfirmDeleteButton
                        confirming={confirmingId === agent.id}
                        busy={busyId === agent.id}
                        onClick={() => void handleDelete(agent.id)}
                      />
                    </td>
                  </tr>
                  {expandedId === agent.id && (
                    <tr className="border-t border-border/40">
                      <td colSpan={5} className="px-3 pb-3 pt-1">
                        <p className="pb-1.5 text-xs font-medium text-ink-muted">
                          该实例的实际系统提示词
                        </p>
                        <PromptBlock text={agent.system_prompt} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-ink-faint">
          {loading ? "加载中…" : "暂无数据"}
        </p>
      )}
      {confirmingId && (
        <p className="pt-2 text-xs text-destructive">
          再次点击确认删除：删除主理人会级联解散其团队，主界面对应会话将失效。
        </p>
      )}

      <p className="pb-2 pt-5 text-xs font-medium text-ink-muted">团队</p>
      {teams.length ? (
        <div className="overflow-hidden rounded-lg bg-card">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-xs text-ink-muted">
                <th className="px-3 py-2 font-medium">名称</th>
                <th className="w-20 px-3 py-2 font-medium">成员数</th>
                <th className="w-28 px-3 py-2 font-medium">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr key={team.id} className="border-t border-border/60">
                  <td className="max-w-0 truncate px-3 py-2 text-foreground">
                    {team.name}
                    {team.description && (
                      <span className="ml-2 text-xs text-ink-faint">
                        {team.description}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-ink-muted">{team.members}</td>
                  <td className="px-3 py-2 text-ink-muted">
                    {formatDate(team.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-ink-faint">
          {loading ? "加载中…" : "暂无数据"}
        </p>
      )}

      <p className="pb-2 pt-5 text-xs font-medium text-ink-muted">
        角色配置（系统提示词 / 技能 / 工具）
      </p>
      {roles.length ? (
        <div className="space-y-2">
          {roles.map((role) => (
            <RoleCard key={role.key} role={role} />
          ))}
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-ink-faint">加载中…</p>
      )}
    </div>
  );
}
