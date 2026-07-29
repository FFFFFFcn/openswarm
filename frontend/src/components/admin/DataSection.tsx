import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { adminApi, formatDate, type AdminRecord } from "@/api/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ConfirmDeleteButton, SectionHeader } from "./shared";

const TABS = [
  { key: "topics", label: "选题" },
  { key: "drafts", label: "草稿" },
  { key: "strategies", label: "策略" },
  { key: "accounts", label: "账号档案" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/** Sentinel value for the "all accounts" option (empty string is reserved by Radix). */
const ALL_ACCOUNTS = "__all__";

const STATUS_OPTIONS: Record<Exclude<TabKey, "accounts">, { value: string; label: string }[]> = {
  topics: [
    { value: "idea", label: "想法" },
    { value: "approved", label: "已通过" },
    { value: "rejected", label: "已拒绝" },
    { value: "drafting", label: "撰写中" },
    { value: "ready", label: "已就绪" },
  ],
  drafts: [
    { value: "draft", label: "草稿" },
    { value: "review", label: "待审" },
    { value: "approved", label: "已通过" },
    { value: "published", label: "已发布" },
  ],
  strategies: [
    { value: "draft", label: "草稿" },
    { value: "approved", label: "已通过" },
    { value: "archived", label: "已归档" },
  ],
};

function rowTitle(tab: TabKey, record: AdminRecord): string {
  if (tab === "strategies") return String(record.positioning ?? record.id);
  return String(record.title ?? record.id);
}

/**
 * Business data management: topics / drafts / strategies with inline
 * status editing (existing PATCH endpoints) and hard deletion (admin
 * DELETE endpoints, two-step confirm). Data tabs can be filtered by
 * account; the account tab lists every account profile in the library.
 */
export function DataSection() {
  const [tab, setTab] = useState<TabKey>("topics");
  const [records, setRecords] = useState<AdminRecord[]>([]);
  const [accounts, setAccounts] = useState<AdminRecord[]>([]);
  const [accountFilter, setAccountFilter] = useState<string>(ALL_ACCOUNTS);
  const [loading, setLoading] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Load the account library once — powers both the filter dropdown and the account tab. */
  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await adminApi.accounts());
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "账号加载失败");
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const refresh = useCallback(
    async (target: TabKey, accountId: string) => {
      setLoading(true);
      setConfirmingId(null);
      try {
        const filter = accountId === ALL_ACCOUNTS ? undefined : accountId;
        if (target === "accounts") {
          await loadAccounts();
        } else if (target === "topics") {
          setRecords(await adminApi.topics(filter));
        } else if (target === "drafts") {
          setRecords(await adminApi.drafts(filter));
        } else {
          setRecords(await adminApi.strategies(filter));
        }
      } catch (reason) {
        toast.error(reason instanceof Error ? reason.message : "加载失败");
      } finally {
        setLoading(false);
      }
    },
    [loadAccounts],
  );

  useEffect(() => {
    void refresh(tab, accountFilter);
  }, [tab, accountFilter, refresh]);

  const changeStatus = async (record: AdminRecord, status: string) => {
    setBusyId(record.id);
    try {
      if (tab === "topics") await adminApi.topicPatch(record.id, { status });
      else if (tab === "drafts") await adminApi.draftPatch(record.id, { status });
      else await adminApi.strategyPatch(record.id, { status });
      toast.success("状态已更新");
      await refresh(tab, accountFilter);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "状态更新失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (record: AdminRecord) => {
    if (confirmingId !== record.id) {
      setConfirmingId(record.id);
      return;
    }
    setBusyId(record.id);
    try {
      if (tab === "topics") await adminApi.topicDelete(record.id);
      else if (tab === "drafts") await adminApi.draftDelete(record.id);
      else await adminApi.strategyDelete(record.id);
      toast.success("已删除");
      await refresh(tab, accountFilter);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  };

  return (
    <div>
      <SectionHeader
        title="业务数据"
        description="查看并管理选题、草稿与策略；删除为不可恢复的硬删除。"
      />
      <div className="flex gap-1 pb-3">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs transition-colors",
              tab === item.key
                ? "bg-accent font-medium text-foreground"
                : "text-ink-secondary hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab !== "accounts" && accounts.length > 0 ? (
        <div className="flex items-center gap-2 pb-3">
          <span className="text-xs text-ink-muted">按账号筛选</span>
          <Select value={accountFilter} onValueChange={setAccountFilter}>
            <SelectTrigger className="h-7 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ACCOUNTS}>全部账号</SelectItem>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {String(account.account_name ?? account.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {tab === "accounts" ? (
        accounts.length ? (
          <div className="space-y-2">
            {accounts.map((account) => (
              <div key={account.id} className="rounded-lg bg-card p-4 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-foreground">
                    {String(account.account_name ?? "—")}
                  </span>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {formatDate(account.updated_at)}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-[80px_1fr] gap-y-1 text-[13px]">
                  <dt className="text-ink-muted">赛道</dt>
                  <dd className="text-foreground">{String(account.niche ?? "—")}</dd>
                  <dt className="text-ink-muted">小红书号</dt>
                  <dd className="text-foreground">{String(account.red_id || "—")}</dd>
                  <dt className="text-ink-muted">目标人群</dt>
                  <dd className="text-foreground">{String(account.target_audience ?? "—")}</dd>
                  <dt className="text-ink-muted">核心目标</dt>
                  <dd className="text-foreground">{String(account.primary_goal ?? "—")}</dd>
                </dl>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-ink-faint">
            {loading ? "加载中…" : "暂无账号档案"}
          </p>
        )
      ) : records.length ? (
        <div className="overflow-hidden rounded-lg bg-card">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-xs text-ink-muted">
                <th className="px-3 py-2 font-medium">
                  {tab === "strategies" ? "定位" : "标题"}
                </th>
                <th className="w-32 px-3 py-2 font-medium">状态</th>
                <th className="w-28 px-3 py-2 font-medium">创建时间</th>
                <th className="w-28 px-3 py-2 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id} className="border-t border-border/60">
                  <td className="max-w-0 truncate px-3 py-2 text-foreground">
                    {rowTitle(tab, record)}
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      value={record.status}
                      disabled={busyId === record.id}
                      onValueChange={(value) => void changeStatus(record, value)}
                    >
                      <SelectTrigger className="h-7 w-28 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS[tab].map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2 text-ink-muted">
                    {formatDate(record.created_at)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ConfirmDeleteButton
                      confirming={confirmingId === record.id}
                      busy={busyId === record.id}
                      onClick={() => void handleDelete(record)}
                    />
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
    </div>
  );
}
