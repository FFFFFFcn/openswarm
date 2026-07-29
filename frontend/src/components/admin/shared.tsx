import { Loader2Icon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Human-readable byte size, e.g. 1.5 MB. */
export function formatBytes(size: number): string {
  if (!size) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatTimestamp(seconds: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(seconds * 1000));
}

/** Section title bar shared by every admin module. */
export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 pb-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
        )}
      </div>
      {actions}
    </div>
  );
}

/**
 * Two-step destructive button following the project-wide confirm pattern:
 * first click arms it ("确认删除"), second click fires onConfirm.
 * The parent controls the armed state so it can reset on selection change.
 */
export function ConfirmDeleteButton({
  confirming,
  busy,
  disabled,
  onClick,
  label = "删除",
}: {
  confirming: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <Button
      variant={confirming ? "destructive" : "ghost"}
      size="sm"
      className="h-7 px-2.5 text-xs"
      disabled={disabled || busy}
      onClick={onClick}
    >
      {busy ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <Trash2Icon className="size-3.5" />
      )}
      {confirming ? "确认删除" : label}
    </Button>
  );
}
