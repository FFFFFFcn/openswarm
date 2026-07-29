import { useCallback, useEffect, useState } from "react";
import {
  BotIcon,
  DatabaseIcon,
  FileTextIcon,
  GaugeIcon,
  HardDriveIcon,
  KeyRoundIcon,
  PlugZapIcon,
  RefreshCwIcon,
  ScrollTextIcon,
} from "lucide-react";
import { toast } from "sonner";
import { adminApi, type AdminOverview } from "@/api/client";
import { AgentTeamSection } from "@/components/admin/AgentTeamSection";
import { CredentialsSection } from "@/components/admin/CredentialsSection";
import { DataSection } from "@/components/admin/DataSection";
import { LogsSection } from "@/components/admin/LogsSection";
import { RedFoxKeySection } from "@/components/admin/RedFoxKeySection";
import { StorageSection } from "@/components/admin/StorageSection";
import { formatBytes, SectionHeader } from "@/components/admin/shared";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const MODULES = [
  { key: "overview", label: "概览", icon: GaugeIcon },
  { key: "data", label: "业务数据", icon: DatabaseIcon },
  { key: "agents", label: "智能体团队", icon: BotIcon },
  { key: "storage", label: "存储清理", icon: HardDriveIcon },
  { key: "credentials", label: "模型凭据", icon: KeyRoundIcon },
  { key: "redfox", label: "数据接口", icon: PlugZapIcon },
  { key: "logs", label: "日志", icon: ScrollTextIcon },
] as const;

type ModuleKey = (typeof MODULES)[number]["key"];

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-card p-4">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-ink-faint">{hint}</p>}
    </div>
  );
}

/** Aggregated disk usage + entity counts, with a manual refresh. */
function OverviewSection() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await adminApi.overview());
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const storage = overview?.storage;
  const counts = overview?.counts ?? {};
  const logsSize = storage
    ? Object.values(storage.logs).reduce((sum, item) => sum + item, 0)
    : 0;

  return (
    <div>
      <SectionHeader
        title="概览"
        description="磁盘占用与业务数据总量统计。"
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
      {storage ? (
        <>
          <p className="pb-2 text-xs font-medium text-ink-muted">磁盘占用</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="业务数据库"
              value={formatBytes(storage.database_size)}
              hint="operations.db"
            />
            <StatCard
              label="报告文件"
              value={formatBytes(storage.reports_size)}
              hint={`${storage.reports_files} 个文件`}
            />
            <StatCard
              label="工作区"
              value={formatBytes(storage.workspaces_size)}
              hint={`${storage.workspaces_count} 个目录`}
            />
            <StatCard
              label="日志文件"
              value={formatBytes(logsSize)}
              hint="backend.log / backend.err.log"
            />
          </div>
          <p className="pb-2 pt-5 text-xs font-medium text-ink-muted">
            数据量
          </p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="选题" value={String(counts.topics ?? 0)} />
            <StatCard label="草稿" value={String(counts.drafts ?? 0)} />
            <StatCard label="策略" value={String(counts.strategies ?? 0)} />
            <StatCard label="模型凭据" value={String(counts.credentials ?? 0)} />
            <StatCard label="智能体" value={String(counts.agents ?? 0)} />
            <StatCard label="团队" value={String(counts.teams ?? 0)} />
          </div>
        </>
      ) : (
        <p className="py-8 text-center text-sm text-ink-faint">
          {loading ? "加载中…" : "暂无数据"}
        </p>
      )}
    </div>
  );
}

/**
 * Hidden admin console, opened in its own tab via /#admin (6 rapid logo
 * clicks). Standalone layout: narrow module nav on the left, content on
 * the right — deliberately not wrapped in the main AppShell.
 */
export function AdminPage() {
  const [module, setModule] = useState<ModuleKey>("overview");

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-[180px] shrink-0 flex-col bg-card">
        <div className="px-4 py-4">
          <p className="text-sm font-semibold text-foreground">管理后台</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">openswarm admin</p>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {MODULES.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setModule(item.key)}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                module === item.key
                  ? "bg-accent font-medium text-foreground"
                  : "font-normal text-ink-secondary hover:bg-accent hover:text-foreground",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto px-4 py-3">
          <p className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <FileTextIcon className="size-3" />
            单用户本地实例
          </p>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        {module === "logs" ? (
          <div className="flex h-full flex-col px-6 py-5">
            <LogsSection />
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="mx-auto max-w-4xl px-6 py-5">
              {module === "overview" && <OverviewSection />}
              {module === "data" && <DataSection />}
              {module === "agents" && <AgentTeamSection />}
              {module === "storage" && <StorageSection />}
              {module === "credentials" && <CredentialsSection />}
              {module === "redfox" && <RedFoxKeySection />}
            </div>
          </ScrollArea>
        )}
      </main>
    </div>
  );
}
