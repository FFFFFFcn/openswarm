import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { adminApi } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatBytes, SectionHeader } from "./shared";

const LOG_NAMES = [
  { key: "backend", label: "运行日志" },
  { key: "error", label: "错误日志" },
] as const;

const TAIL_OPTIONS = [200, 500, 2000] as const;

/** Marks a line as error-ish for red highlighting in the viewer. */
function isErrorLine(line: string): boolean {
  return /\b(ERROR|CRITICAL|Traceback|Exception)\b/.test(line);
}

/**
 * Log viewer: manual pull of the tail of backend.log / backend.err.log
 * with a selectable line count. No live streaming by design.
 */
export function LogsSection() {
  const [name, setName] = useState<"backend" | "error">("backend");
  const [tail, setTail] = useState<number>(200);
  const [lines, setLines] = useState<string[]>([]);
  const [size, setSize] = useState(0);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminApi.logs(name, tail);
      setLines(result.lines);
      setSize(result.size);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "日志加载失败");
    } finally {
      setLoading(false);
    }
  }, [name, tail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        title="日志"
        description={`文件大小 ${formatBytes(size)}，显示末尾 ${lines.length} 行。`}
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
      <div className="flex items-center gap-3 pb-3">
        <div className="flex gap-1">
          {LOG_NAMES.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setName(item.key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs transition-colors",
                name === item.key
                  ? "bg-accent font-medium text-foreground"
                  : "text-ink-secondary hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {TAIL_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setTail(option)}
              className={cn(
                "rounded-md px-2 py-1.5 text-xs transition-colors",
                tail === option
                  ? "bg-accent font-medium text-foreground"
                  : "text-ink-faint hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {option} 行
            </button>
          ))}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 rounded-lg bg-card">
        <pre className="whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-5 text-ink-secondary">
          {lines.length
            ? lines.map((line, index) => (
                <span
                  key={index}
                  className={cn("block", isErrorLine(line) && "text-red-500")}
                >
                  {line || " "}
                </span>
              ))
            : loading
              ? "加载中…"
              : "日志为空"}
        </pre>
      </ScrollArea>
    </div>
  );
}
