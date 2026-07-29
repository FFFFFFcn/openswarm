import { AlertTriangleIcon } from "lucide-react";
import type { PendingConfirm } from "@/api/types";
import { Button } from "@/components/ui/button";
import { formatToolInput, toolDisplayName } from "./meta";

/**
 * HITL authorization card. Warns that an external data call needs approval,
 * lists the pending tool calls, and offers approve / reject actions.
 */
export function ConfirmCard({
  confirm,
  onConfirm,
}: {
  confirm: PendingConfirm;
  onConfirm: (confirm: PendingConfirm, approved: boolean) => void;
}) {
  return (
    <div className="rounded-xl bg-muted p-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-ink-secondary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            外部数据调用需要授权
          </p>
          <p className="mt-0.5 text-[13px] text-ink-muted">
            {confirm.workerName} 请求执行以下操作，请确认后再继续。
          </p>
        </div>
      </div>

      <ul className="mt-3 flex flex-col gap-2">
        {confirm.toolCalls.map((call) => (
          <li
            key={call.id}
            className="rounded-lg bg-card px-3 py-2 text-[13px]"
          >
            <code
              className="font-semibold text-ink-secondary"
              title={call.name}
            >
              {toolDisplayName(call.name)}
            </code>
            {call.input ? (
              <p className="mt-1 break-words text-ink-muted">
                {formatToolInput(call.input)}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex justify-end gap-2">
        <Button
          size="sm"
          variant="destructive"
          onClick={() => onConfirm(confirm, false)}
        >
          拒绝
        </Button>
        <Button size="sm" onClick={() => onConfirm(confirm, true)}>
          批准
        </Button>
      </div>
    </div>
  );
}
