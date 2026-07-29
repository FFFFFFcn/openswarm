import { useRef, useState } from "react";
import { FolderOpenIcon, Loader2Icon, MoreHorizontalIcon, PencilIcon, PinIcon, PinOffIcon, PlusIcon, SettingsIcon, Trash2Icon, UsersIcon } from "lucide-react";
import type { ConversationMeta, PageKey } from "@/api/types";
import { cn } from "@/lib/utils";
import { groupByDate } from "@/utils/conversations";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import logoUrl from "@/assets/logo.png";

/**
 * Left column: brand logo, "新对话" action button, "资产库" navigation,
 * the conversation history list grouped by date, and a settings icon
 * pinned to the bottom.
 */
export function ProjectPanel({
  page,
  onNavigate,
  conversations,
  viewingId,
  runningIds,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onPinConversation,
  onRenameConversation,
}: {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  conversations: ConversationMeta[];
  viewingId: string | null;
  /** Conversations currently executing tasks — shows a spinner in each row. */
  runningIds: Set<string>;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  onPinConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Hidden admin console entry: 6 rapid clicks on the logo (each within
  // 800ms of the previous) opens /#admin in a new tab.
  const logoClicks = useRef({ count: 0, last: 0 });

  const handleLogoClick = () => {
    const now = Date.now();
    const tracker = logoClicks.current;
    tracker.count = now - tracker.last <= 800 ? tracker.count + 1 : 1;
    tracker.last = now;
    if (tracker.count >= 6) {
      tracker.count = 0;
      window.open("/#admin", "_blank", "noopener");
    }
    onNavigate("team");
  };

  const sorted = [...conversations].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  const pinned = sorted.filter((c) => c.pinned);
  const groups = groupByDate(sorted.filter((c) => !c.pinned));

  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      onRenameConversation(renamingId, renameValue);
    }
    setRenamingId(null);
  };
  return (
    <div className="flex h-full flex-col bg-card">
      <button
        type="button"
        onClick={handleLogoClick}
        className="flex items-center px-4 py-4 text-left"
        aria-label="openswarm"
      >
        <img src={logoUrl} alt="蜂群引力AI" className="h-12" />
      </button>

      <nav className="flex flex-col gap-1 px-2">
        <button
          type="button"
          onClick={onNewConversation}
          className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-normal text-ink-secondary transition-colors hover:bg-accent hover:text-foreground"
        >
          <PlusIcon className="size-4" />
          新对话
        </button>
        <button
          type="button"
          onClick={() => onNavigate("accounts")}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
            page === "accounts"
              ? "bg-accent text-foreground"
              : "font-normal text-ink-secondary hover:bg-accent hover:text-foreground",
          )}
        >
          <UsersIcon className="size-4" />
          账号库
        </button>
        <button
          type="button"
          onClick={() => onNavigate("assets")}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
            page === "assets"
              ? "bg-accent text-foreground"
              : "font-normal text-ink-secondary hover:bg-accent hover:text-foreground",
          )}
        >
          <FolderOpenIcon className="size-4" />
          资产库
        </button>
      </nav>

      <div className="mt-4 flex min-h-0 flex-1 flex-col px-2">
        <div className="px-3 pb-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            对话
          </p>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5">
          {sorted.length ? (
            <>
              {pinned.length > 0 && (
                <div>
                  <p className="px-3 pb-1 pt-3 text-[11px] font-medium text-ink-faint">
                    已置顶
                  </p>
                  {pinned.map((conversation) => (
                    <ConversationItem
                      key={conversation.id}
                      conversation={conversation}
                      selected={page === "team" && viewingId === conversation.id}
                      running={runningIds.has(conversation.id)}
                      renaming={renamingId === conversation.id}
                      renameValue={renameValue}
                      onSelect={() => onSelectConversation(conversation.id)}
                      onRenameChange={setRenameValue}
                      onRenameCommit={commitRename}
                      onRenameCancel={() => setRenamingId(null)}
                      onPin={() => onPinConversation(conversation.id)}
                      onStartRename={() => {
                        setRenamingId(conversation.id);
                        setRenameValue(conversation.title);
                      }}
                      onDelete={() => onDeleteConversation(conversation.id)}
                    />
                  ))}
                </div>
              )}
              {groups.map((group) => (
                <div key={group.label}>
                  <p className="px-3 pb-1 pt-3 text-[11px] font-medium text-ink-faint">
                    {group.label}
                  </p>
                  {group.items.map((conversation) => (
                    <ConversationItem
                      key={conversation.id}
                      conversation={conversation}
                      selected={page === "team" && viewingId === conversation.id}
                      running={runningIds.has(conversation.id)}
                      renaming={renamingId === conversation.id}
                      renameValue={renameValue}
                      onSelect={() => onSelectConversation(conversation.id)}
                      onRenameChange={setRenameValue}
                      onRenameCommit={commitRename}
                      onRenameCancel={() => setRenamingId(null)}
                      onPin={() => onPinConversation(conversation.id)}
                      onStartRename={() => {
                        setRenamingId(conversation.id);
                        setRenameValue(conversation.title);
                      }}
                      onDelete={() => onDeleteConversation(conversation.id)}
                    />
                  ))}
                </div>
              ))}
            </>
          ) : (
            <p className="px-3 py-1.5 text-xs text-ink-faint">
              还没有对话，发送任务即可开始
            </p>
          )}
          </div>
        </ScrollArea>
      </div>

      <div className="px-2 py-3">
        <button
          type="button"
          onClick={() => onNavigate("settings")}
          aria-label="设置"
          title="设置"
          className={cn(
            "flex size-9 items-center justify-center rounded-md transition-colors",
            page === "settings"
              ? "bg-accent text-foreground"
              : "text-ink-secondary hover:bg-accent hover:text-foreground",
          )}
        >
          <SettingsIcon className="size-[18px]" />
        </button>
      </div>
    </div>
  );
}

/** A single conversation row with hover "more" menu (pin / rename / delete). */
function ConversationItem({
  conversation,
  selected,
  running,
  renaming,
  renameValue,
  onSelect,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onPin,
  onStartRename,
  onDelete,
}: {
  conversation: ConversationMeta;
  selected: boolean;
  running: boolean;
  renaming: boolean;
  renameValue: string;
  onSelect: () => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onPin: () => void;
  onStartRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative flex items-center">
      {renaming ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRenameCommit();
            if (e.key === "Escape") onRenameCancel();
          }}
          className="min-w-0 flex-1 rounded-md bg-muted py-1.5 pl-3 pr-9 text-sm outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 pl-3 pr-9 text-left text-sm transition-colors",
            selected
              ? "bg-accent font-medium text-foreground"
              : "text-ink-secondary hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {running && (
            <Loader2Icon
              className="size-3.5 shrink-0 animate-spin text-sticker-orange"
              aria-label="任务进行中"
            />
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{conversation.title}</span>
            {conversation.account ? (
              <span className="truncate text-[11px] font-normal text-ink-faint">
                @{conversation.account.name}
              </span>
            ) : null}
          </span>
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="更多操作"
            className={cn(
              // Reveal on hover for real pointer devices; keep it visible while
              // the menu is open. Tailwind's `group-hover` compiles to
              // `@media (hover:hover)`, which fails on touch/hybrid devices
              // (e.g. touchscreen laptops) whose primary pointer can't hover,
              // so also force it visible when `(hover:none)` and on the touch
              // drawer (below `lg`). `focus-visible:outline-none` suppresses the
              // browser's default focus ring so no stray outline lingers after
              // the menu closes.
              "absolute right-1 flex size-7 items-center justify-center rounded-md text-ink-muted opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100 max-lg:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:outline-none",
            )}
          >
            <MoreHorizontalIcon className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-32">
          <DropdownMenuItem onClick={onPin}>
            {conversation.pinned ? <PinOffIcon /> : <PinIcon />}
            {conversation.pinned ? "取消置顶" : "置顶"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onStartRename}>
            <PencilIcon />
            重命名
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2Icon />
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
