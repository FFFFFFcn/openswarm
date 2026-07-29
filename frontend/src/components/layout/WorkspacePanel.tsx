import { useEffect, useRef, useState } from "react";
import {
  ExternalLinkIcon,
  FileTextIcon,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatDate } from "@/api/client";
import type { Artifact, ChatImage, ChatItem, TaskCard, WorkerLogEntry } from "@/api/types";
import { finishReasonLabels, formatTokens, roleNames, statusMeta, toolDisplayName } from "@/components/chat/meta";
import { ArtifactPreview } from "@/components/reports/ArtifactPreview";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type Tab = "log" | "files" | "preview";

const tabLabels: Record<Tab, string> = {
  log: "日志",
  files: "产出物",
  preview: "预览",
};

/**
 * Right column: a tabbed workspace panel with agent work log, artifact
 * file list and inline file preview. Rendered on the team page.
 */
export function WorkspacePanel({
  artifacts,
  items,
}: {
  artifacts: Artifact[];
  items: ChatItem[];
}) {
  const [tab, setTab] = useState<Tab>("log");
  const [previewId, setPreviewId] = useState<string | null>(null);
  /** Artifact ids already seen — used to detect brand-new artifacts. */
  const knownIdsRef = useRef<Set<string> | null>(null);

  // When a new artifact is generated, jump straight to its preview so the
  // user sees the fresh output without manually opening the files tab.
  useEffect(() => {
    if (knownIdsRef.current !== null) {
      const fresh = artifacts.find((a) => !knownIdsRef.current!.has(a.id));
      if (fresh) {
        setPreviewId(fresh.id);
        setTab("preview");
      }
    }
    knownIdsRef.current = new Set(artifacts.map((a) => a.id));
  }, [artifacts]);

  const tasks = items.flatMap((item) =>
    item.kind === "task" ? [{ id: item.id, task: item.task }] : [],
  );
  const preview = artifacts.find((a) => a.id === previewId) ?? null;

  const openPreview = (item: Artifact) => {
    setPreviewId(item.id);
    setTab("preview");
  };

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        {(Object.keys(tabLabels) as Tab[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "rounded-md px-3 py-1.5 text-[13px] transition-colors",
              tab === key
                ? "bg-muted font-medium text-foreground"
                : "text-ink-muted hover:text-foreground",
            )}
          >
            {tabLabels[key]}
          </button>
        ))}
      </div>

      {tab === "log" && <LogView tasks={tasks} />}

      {tab === "files" && (
        <FileListView artifacts={artifacts} onOpen={openPreview} />
      )}

      {tab === "preview" && <PreviewView artifact={preview} />}
    </div>
  );
}

/* ---------- 日志 tab ---------- */

/** Status dot + label for a tool invocation in the work-log timeline. */
const toolStatusMeta: Record<"running" | "done" | "error", { label: string; dot: string }> = {
  running: { label: "执行中", dot: "bg-sticker-orange animate-pulse" },
  done: { label: "已完成", dot: "bg-sticker-green" },
  error: { label: "失败", dot: "bg-destructive" },
};

function ToolBadge({ entry }: { entry: Extract<WorkerLogEntry, { kind: "tool" }> }) {
  const meta = toolStatusMeta[entry.status];
  return (
    <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-muted px-2.5 py-1">
      <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} />
      <span className="text-[11px] text-ink-secondary" title={entry.name}>
        {toolDisplayName(entry.name)}
      </span>
      <span className="text-[11px] text-ink-muted">{meta.label}</span>
    </span>
  );
}

function ImageRow({ images }: { images: ChatImage[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((image) => (
        <img
          key={image.blockId}
          src={image.src}
          alt=""
          loading="lazy"
          className="max-h-40 rounded-md border border-border object-contain"
        />
      ))}
    </div>
  );
}

const commentaryClass =
  "prose prose-compact max-w-none break-words text-[13px] leading-relaxed text-ink-secondary prose-headings:text-[13px] prose-headings:font-semibold prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-code:text-[12px] prose-code:text-ink-secondary prose-pre:bg-muted prose-pre:text-[12px] prose-pre:text-foreground prose-th:text-[13px] prose-td:text-[13px] prose-strong:text-foreground";

/** One chronological worker-log entry (commentary / thinking / tool / hint / image). */
function LogEntry({ entry }: { entry: WorkerLogEntry }) {
  switch (entry.kind) {
    case "text":
      return (
        <div className={commentaryClass}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
        </div>
      );
    case "thinking":
      return (
        <details className="text-[12px]">
          <summary className="cursor-pointer select-none text-ink-faint transition-colors hover:text-ink-muted">
            思考过程
          </summary>
          <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-border pl-3 leading-relaxed text-ink-muted">
            {entry.text}
          </div>
        </details>
      );
    case "hint":
      return (
        <div className="rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-[12px] leading-relaxed text-ink-muted">
          {entry.source ? (
            <span className="mr-1 font-medium text-ink-secondary">{entry.source}：</span>
          ) : null}
          <span className="whitespace-pre-wrap break-words">{entry.text}</span>
          {entry.images?.length ? (
            <div className="mt-1.5">
              <ImageRow images={entry.images} />
            </div>
          ) : null}
        </div>
      );
    case "image":
      return <ImageRow images={[entry.image]} />;
    case "tool":
      return (
        <div className="flex flex-col gap-1">
          <ToolBadge entry={entry} />
          {entry.output ? (
            <details className="text-[12px]">
              <summary className="cursor-pointer select-none text-ink-faint transition-colors hover:text-ink-muted">
                查看输出
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-[11px] leading-relaxed text-ink-secondary">
                {entry.output}
              </pre>
            </details>
          ) : null}
          {entry.images?.length ? <ImageRow images={entry.images} /> : null}
        </div>
      );
    default:
      return null;
  }
}

function LogView({
  tasks,
}: {
  tasks: Array<{ id: string; task: TaskCard }>;
}) {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-xs text-ink-faint">暂无工作日志，发送任务后这里会记录执行过程</p>
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-5 px-3 pb-4">
        {tasks.map(({ id, task }) => {
          const status = statusMeta[task.status];
          const roleName = roleNames[task.role] ?? task.role;
          const entries = task.entries ?? [];
          // Legacy archives predate `entries`; fall back to the old narration.
          const legacyText = entries.length === 0 ? task.narration : "";
          const reasonLabel = task.finishedReason ? finishReasonLabels[task.finishedReason] : undefined;
          const usage = task.usage;
          const showUsage = usage && usage.inputTokens + usage.outputTokens > 0;
          return (
            <div key={id}>
              <div className="flex items-center gap-2">
                <span className="size-2 shrink-0 rounded-full bg-foreground" />
                <span className="truncate text-[13px] font-medium text-foreground">
                  {task.agentName}
                </span>
                <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] text-ink-muted">
                  {roleName} · {status.label}
                </span>
                {reasonLabel ? (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-ink-muted">
                    {reasonLabel}
                  </span>
                ) : null}
                {showUsage ? (
                  <span className="shrink-0 text-[11px] text-ink-faint">
                    ↑{formatTokens(usage.inputTokens)} ↓{formatTokens(usage.outputTokens)}
                  </span>
                ) : null}
              </div>
              {/* Task summary intentionally hidden — user already knows the task. */}
              <div className="mt-2 ml-1 flex flex-col gap-2.5 border-l border-border pl-4">
                {entries.map((entry, index) => (
                  <LogEntry key={index} entry={entry} />
                ))}
                {legacyText ? (
                  <div className={commentaryClass}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {legacyText.slice(-600)}
                    </ReactMarkdown>
                  </div>
                ) : null}
                {entries.length === 0 && !legacyText && task.status === "starting" ? (
                  <p className="text-xs text-ink-faint">正在启动…</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

/* ---------- 产出物 tab ---------- */

function FileListView({
  artifacts,
  onOpen,
}: {
  artifacts: Artifact[];
  onOpen: (item: Artifact) => void;
}) {
  if (artifacts.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-xs text-ink-faint">暂无产出物</p>
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul className="flex flex-col gap-1 px-2 pb-3">
        {artifacts.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-accent"
          >
            <FileTextIcon className="size-4 shrink-0 text-ink-faint" />
            <button
              type="button"
              onClick={() => onOpen(item)}
              className="flex min-w-0 flex-1 flex-col items-start text-left"
            >
              <span className="w-full truncate text-sm text-foreground">
                {item.name}
              </span>
              <span className="text-xs text-ink-muted">
                {formatDate(item.updated_at)}
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={() =>
                window.open(`/api/v1/artifacts/${item.id}`, "_blank", "noopener")
              }
              aria-label="新标签打开"
            >
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

/* ---------- 预览 tab ---------- */

function PreviewView({ artifact }: { artifact: Artifact | null }) {
  if (!artifact) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-xs text-ink-faint">在“产出物”中选择文件即可查看预览</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="truncate text-[13px] font-medium text-foreground">
          {artifact.name}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() =>
            window.open(`/api/v1/artifacts/${artifact.id}`, "_blank", "noopener")
          }
          aria-label="新标签页打开"
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>
      <ArtifactPreview artifact={artifact} />
    </div>
  );
}
