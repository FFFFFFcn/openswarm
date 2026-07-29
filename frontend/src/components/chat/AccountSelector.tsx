import { CheckIcon, ChevronDownIcon, UserRoundIcon } from "lucide-react";
import type { AccountProfile } from "@/api/types";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Compact account-binding chip shown above the composer: `账号：不选 ▾`.
 * Picking an account binds the conversation to it — the next message carries
 * the account marker so the agent team works on that account; "不绑定账号"
 * returns to a general-purpose conversation.
 */
export function AccountSelector({
  accounts,
  selected,
  onSelect,
  onOpen,
}: {
  accounts: AccountProfile[];
  selected: { id: string; name: string } | null;
  onSelect: (account: { id: string; name: string } | null) => void;
  /** Called when the dropdown opens, to refresh the account list. */
  onOpen?: () => void;
}) {
  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen?.()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors",
            selected
              ? "bg-accent font-medium text-foreground"
              : "bg-muted text-ink-muted hover:text-foreground",
          )}
        >
          <UserRoundIcon className="size-3.5" />
          账号：{selected ? selected.name : "不选"}
          <ChevronDownIcon className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onSelect(null)}>
          <span className="flex-1">不绑定账号</span>
          {!selected && <CheckIcon className="size-3.5" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {accounts.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-ink-faint">
            账号库为空，请先在「账号库」录入
          </div>
        ) : (
          accounts.map((account) => (
            <DropdownMenuItem
              key={account.id}
              onSelect={() => onSelect({ id: account.id, name: account.account_name })}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{account.account_name}</span>
                <span className="block truncate text-[11px] text-ink-faint">
                  {account.niche}
                </span>
              </span>
              {selected?.id === account.id && <CheckIcon className="size-3.5 shrink-0" />}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
