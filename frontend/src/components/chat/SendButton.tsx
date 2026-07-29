import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Circular primary send button shared by every conversation input surface
 * (welcome screen task input, chat composer, …) for a consistent look.
 * While a task is running it flips into a stop button.
 */
export function SendButton({
  disabled,
  onClick,
  className,
  mode = "send",
}: {
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  mode?: "send" | "stop";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={mode === "stop" ? "停止" : "发送"}
      title={mode === "stop" ? "停止当前任务" : undefined}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-active",
        "disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-faint",
        className,
      )}
    >
      {mode === "stop" ? (
        <SquareIcon className="size-3.5 fill-current" />
      ) : (
        <ArrowUpIcon className="size-4" />
      )}
    </button>
  );
}
