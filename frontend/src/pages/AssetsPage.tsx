import { useEffect, useState } from "react";
import {
  CheckSquareIcon,
  ExternalLinkIcon,
  FileTextIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { artifactsApi } from "@/api/client";
import type { Artifact } from "@/api/types";
import { ArtifactPreview } from "@/components/reports/ArtifactPreview";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/**
 * Artifact ids carry a task-type prefix (`title-` / `account-` / `cover-`);
 * bare uuids are hot-note insight reports. Group the library by that prefix.
 */
const CATEGORIES = [
  { key: "insight", label: "热点洞察" },
  { key: "account", label: "账号对标" },
  { key: "title", label: "标题优化" },
  { key: "cover", label: "封面设计" },
] as const;

function categoryOf(artifact: Artifact): (typeof CATEGORIES)[number]["key"] {
  if (artifact.id.startsWith("account-")) return "account";
  if (artifact.id.startsWith("title-")) return "title";
  if (artifact.id.startsWith("cover-")) return "cover";
  return "insight";
}

/**
 * Asset library with a master-detail layout: left directory panel grouped
 * by task type, right detail panel. Artifacts with a JSON data sibling
 * render natively with the app design system; legacy HTML-only artifacts
 * fall back to the sandboxed iframe preview (see ArtifactPreview).
 */
export function AssetsPage({
  artifacts,
  onDeleted,
}: {
  artifacts: Artifact[];
  onDeleted: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Manage mode: checkboxes replace navigation, footer offers batch delete.
  const [managing, setManaging] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Auto-select the first artifact when list loads / refreshes.
  useEffect(() => {
    const first = artifacts[0];
    if (first && !artifacts.some((a) => a.id === selectedId)) {
      setSelectedId(first.id);
    }
  }, [artifacts, selectedId]);

  const selected = artifacts.find((a) => a.id === selectedId) ?? null;

  const groups = CATEGORIES.map((category) => ({
    ...category,
    items: artifacts.filter((item) => categoryOf(item) === category.key),
  })).filter((group) => group.items.length > 0);

  const toggleManaging = () => {
    setManaging((prev) => !prev);
    setCheckedIds(new Set());
    setConfirmingDelete(false);
  };

  const toggleChecked = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmingDelete(false);
  };

  const handleDelete = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await artifactsApi.batchDelete([...checkedIds]);
      toast.success(`已删除 ${checkedIds.size} 项产物`);
      if (selectedId && checkedIds.has(selectedId)) setSelectedId(null);
      setCheckedIds(new Set());
      setManaging(false);
      onDeleted();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div className="flex h-full">
      {/* Directory panel */}
      <div className="flex w-[260px] shrink-0 flex-col bg-card">
        <div className="flex items-center justify-between px-3 py-3">
          <h2 className="text-sm font-semibold text-foreground">资产库</h2>
          {artifacts.length > 0 && (
            <button
              type="button"
              onClick={toggleManaging}
              className="rounded-md px-2 py-0.5 text-xs text-ink-secondary transition-colors hover:bg-accent hover:text-foreground"
            >
              {managing ? "完成" : "管理"}
            </button>
          )}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5 px-1.5 pb-3">
            {groups.length ? (
              groups.map((group) => (
                <div key={group.key}>
                  <p className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-ink-faint">
                    {group.label}
                  </p>
                  {group.items.map((item) => {
                    const checked = checkedIds.has(item.id);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() =>
                          managing
                            ? toggleChecked(item.id)
                            : setSelectedId(item.id)
                        }
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                          (managing ? checked : item.id === selectedId)
                            ? "bg-accent font-medium text-foreground"
                            : "text-ink-secondary hover:bg-accent/60 hover:text-foreground",
                        )}
                      >
                        {managing ? (
                          checked ? (
                            <CheckSquareIcon className="size-3.5 shrink-0 text-foreground" />
                          ) : (
                            <SquareIcon className="size-3.5 shrink-0 text-ink-faint" />
                          )
                        ) : (
                          <FileTextIcon className="size-3.5 shrink-0 text-ink-faint" />
                        )}
                        <span className="truncate">{item.name}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            ) : (
              <p className="px-2.5 py-2 text-xs text-ink-faint">
                暂无产物
              </p>
            )}
          </div>
        </ScrollArea>
        {managing && (
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
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
              {deleting
                ? "删除中…"
                : confirmingDelete
                  ? "确认删除"
                  : "删除"}
            </Button>
          </div>
        )}
      </div>

      {/* Detail panel */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex items-center justify-between bg-card px-4 py-2.5">
              <span className="truncate text-sm font-medium text-foreground">
                {selected.name}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={() =>
                  window.open(
                    `/api/v1/artifacts/${selected.id}`,
                    "_blank",
                    "noopener",
                  )
                }
                aria-label="新标签打开"
              >
                <ExternalLinkIcon className="size-3.5" />
              </Button>
            </div>
            <ArtifactPreview artifact={selected} />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <FileTextIcon className="size-10 text-ink-faint" />
            <p className="text-sm text-ink-muted">暂无产物</p>
            <p className="text-xs text-ink-faint">
              完成任务后，生成的报告会出现在这里
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
