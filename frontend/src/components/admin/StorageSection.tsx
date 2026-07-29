import { useCallback, useEffect, useState } from "react";
import { CheckSquareIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { adminApi, type AdminWorkspace } from "@/api/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBytes, formatTimestamp, SectionHeader } from "./shared";

/**
 * Storage cleanup: multi-select workspace directories with a two-step
 * confirmed batch delete, mirroring the asset library manage mode.
 * Reports live in the asset library and are only summarized here.
 */
export function StorageSection() {
  const [items, setItems] = useState<AdminWorkspace[]>([]);
  const [reportsSize, setReportsSize] = useState(0);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setConfirming(false);
    setCheckedIds(new Set());
    try {
      const [workspaces, overview] = await Promise.all([
        adminApi.workspaces(),
        adminApi.overview(),
      ]);
      setItems(workspaces);
      setReportsSize(overview.storage.reports_size);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleChecked = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirming(false);
  };

  const toggleAll = () => {
    setCheckedIds((prev) =>
      prev.size === items.length
        ? new Set()
        : new Set(items.map((item) => item.id)),
    );
    setConfirming(false);
  };

  const handleDelete = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setDeleting(true);
    try {
      const result = await adminApi.workspacesDelete([...checkedIds]);
      toast.success(`已删除 ${result.deleted.length} 个工作区目录`);
      await refresh();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <div>
      <SectionHeader
        title="存储清理"
        description="清理智能体任务遗留的工作区目录；删除不可恢复。"
      />
      <p className="pb-3 text-xs text-ink-muted">
        报告文件占用 {formatBytes(reportsSize)}，请前往主界面「资产库」管理。
      </p>

      {items.length ? (
        <div className="overflow-hidden rounded-lg bg-card">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-xs text-ink-muted">
                <th className="w-10 px-3 py-2">
                  <button
                    type="button"
                    onClick={toggleAll}
                    aria-label="全选"
                    className="flex items-center"
                  >
                    {checkedIds.size === items.length ? (
                      <CheckSquareIcon className="size-3.5 text-foreground" />
                    ) : (
                      <SquareIcon className="size-3.5 text-ink-faint" />
                    )}
                  </button>
                </th>
                <th className="px-3 py-2 font-medium">工作区 ID</th>
                <th className="w-20 px-3 py-2 font-medium">文件数</th>
                <th className="w-24 px-3 py-2 font-medium">大小</th>
                <th className="w-28 px-3 py-2 font-medium">更新时间</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const checked = checkedIds.has(item.id);
                return (
                  <tr
                    key={item.id}
                    className={cn(
                      "cursor-pointer border-t border-border/60 transition-colors",
                      checked ? "bg-accent/50" : "hover:bg-accent/30",
                    )}
                    onClick={() => toggleChecked(item.id)}
                  >
                    <td className="px-3 py-2">
                      {checked ? (
                        <CheckSquareIcon className="size-3.5 text-foreground" />
                      ) : (
                        <SquareIcon className="size-3.5 text-ink-faint" />
                      )}
                    </td>
                    <td className="max-w-0 truncate px-3 py-2 font-mono text-xs text-foreground">
                      {item.id}
                    </td>
                    <td className="px-3 py-2 text-ink-muted">{item.files}</td>
                    <td className="px-3 py-2 text-ink-muted">
                      {formatBytes(item.size)}
                    </td>
                    <td className="px-3 py-2 text-ink-muted">
                      {formatTimestamp(item.updated_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-ink-faint">
          暂无工作区目录
        </p>
      )}

      {items.length > 0 && (
        <div className="flex items-center justify-between pt-3">
          <span className="text-xs text-ink-muted">
            已选 {checkedIds.size} 项
          </span>
          <Button
            variant="destructive"
            size="sm"
            className="h-7 rounded-full px-3 text-xs"
            disabled={checkedIds.size === 0 || deleting}
            onClick={() => void handleDelete()}
          >
            <Trash2Icon className="size-3.5" />
            {deleting ? "删除中…" : confirming ? "确认删除" : "删除"}
          </Button>
        </div>
      )}
    </div>
  );
}
