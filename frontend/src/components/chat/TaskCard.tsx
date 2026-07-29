import { Loader2Icon, UserRoundIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PendingConfirm, TaskCard } from "@/api/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { ConfirmCard } from "./ConfirmCard";
import { statusMeta } from "./meta";

/**
 * Subagent task rendered as a group-chat message: notion-style avatar +
 * "name | status" header + white bubble containing live narration / final
 * summary and any pending confirm card.
 */
export function TaskCardView({
  task,
  onConfirm,
}: {
  task: TaskCard;
  onConfirm: (confirm: PendingConfirm, approved: boolean) => void;
}) {
  const status = statusMeta[task.status];

  // Prefer the final summary once done; otherwise show live narration.
  const content =
    (task.status === "done" || task.status === "error") && task.summary
      ? task.summary
      : task.narration;
  const showTyping = !content;

  return (
    <div className="flex gap-3">
      <Avatar className="mt-0.5 size-8 shrink-0">
        <AvatarFallback className="bg-muted text-ink-secondary">
          <UserRoundIcon className="size-4" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 max-w-[78%]">
        <p className="mb-1.5 flex items-center gap-2 text-xs">
          <span className="font-medium text-foreground">{task.agentName}</span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
              status.className,
            )}
          >
            {status.spin && <Loader2Icon className="size-3 animate-spin" />}
            {status.label}
          </span>
        </p>
        <div className="rounded-xl rounded-tl-xs bg-card px-4 py-3 text-sm leading-relaxed text-foreground">
          {showTyping ? (
            <span className="text-ink-faint">正在执行任务…</span>
          ) : (
            <div className="prose prose-sm max-w-none break-words prose-headings:tracking-tight prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:bg-muted prose-pre:text-foreground prose-code:text-ink-secondary">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}

          {task.confirm ? (
            <div className="mt-3">
              <ConfirmCard confirm={task.confirm} onConfirm={onConfirm} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
