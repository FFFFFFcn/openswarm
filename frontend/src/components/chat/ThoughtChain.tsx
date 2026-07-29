import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import type { TaskStep } from "@/api/types";
import { cn } from "@/lib/utils";
import { toolDisplayName } from "./meta";

function StepIcon({ status }: { status: TaskStep["status"] }) {
  if (status === "running") {
    return <Loader2Icon className="size-3.5 animate-spin text-primary" />;
  }
  if (status === "error") {
    return <XIcon className="size-3.5 text-destructive" />;
  }
  return <CheckIcon className="size-3.5 text-sticker-green" />;
}

/**
 * Vertical list of tool-execution steps shown inside an expanded task card.
 * Mirrors the original `@ant-design/x` ThoughtChain: running spinner,
 * done checkmark, error cross.
 */
export function ThoughtChain({ steps }: { steps: TaskStep[] }) {
  if (steps.length === 0) return null;

  return (
    <ol className="flex flex-col gap-1.5">
      {steps.map((step) => (
        <li
          key={step.toolCallId}
          className="flex items-center gap-2 text-[13px] text-ink-secondary"
        >
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full bg-muted",
            )}
          >
            <StepIcon status={step.status} />
          </span>
          <span className="truncate" title={step.name}>
            {toolDisplayName(step.name)}
          </span>
        </li>
      ))}
    </ol>
  );
}
