import { useEffect, useState, type ReactNode } from "react";
import { FolderOpenIcon, MenuIcon } from "lucide-react";
import type { Artifact, ChatItem, ConversationMeta, PageKey } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ProjectPanel } from "./layout/ProjectPanel";
import { WorkspacePanel } from "./layout/WorkspacePanel";

const pageTitles: Record<PageKey, string> = {
  team: "智能体编辑部",
  accounts: "账号库",
  assets: "资产库",
  settings: "模型设置",
  admin: "管理后台",
};

/**
 * Three-column workbench shell: left project panel (260px) · center content
 * (fluid) · right workspace panel (340px) at the `lg` breakpoint. Below `lg`
 * only the center column shows; the left and right panels collapse into
 * Sheet drawers toggled from a slim mobile top bar. Hash routing is kept.
 */
export function AppShell({
  page,
  onNavigate,
  conversations,
  viewingId,
  runningIds,
  artifacts,
  items,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onPinConversation,
  onRenameConversation,
  children,
}: {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  conversations: ConversationMeta[];
  viewingId: string | null;
  /** Conversations currently executing tasks (spinners in the sidebar). */
  runningIds: Set<string>;
  artifacts: Artifact[];
  items: ChatItem[];
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  onPinConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  children: ReactNode;
}) {
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);

  useEffect(() => {
    window.history.replaceState(null, "", `#${page}`);
  }, [page]);

  const navigate = (next: PageKey) => {
    onNavigate(next);
    setLeftOpen(false);
  };

  const projectPanel = (
    <ProjectPanel
      page={page}
      onNavigate={navigate}
      conversations={conversations}
      viewingId={viewingId}
      runningIds={runningIds}
      onSelectConversation={onSelectConversation}
      onNewConversation={onNewConversation}
      onDeleteConversation={onDeleteConversation}
      onPinConversation={onPinConversation}
      onRenameConversation={onRenameConversation}
    />
  );

  const workspacePanel = (
    <WorkspacePanel artifacts={artifacts} items={items} />
  );

  const showWorkspace = page === "team" && viewingId !== null;

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <aside className="hidden w-[260px] shrink-0 lg:block">
        {projectPanel}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-2 bg-card px-3 py-2 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => setLeftOpen(true)}
            aria-label="打开导航"
          >
            <MenuIcon className="size-4" />
          </Button>
          <span className="text-[15px] font-semibold tracking-title text-foreground">
            {pageTitles[page]}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => setRightOpen(true)}
            aria-label="打开工作区"
          >
            <FolderOpenIcon className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </main>

      {showWorkspace && (
        <aside className="hidden w-[800px] shrink-0 lg:block">
          {workspacePanel}
        </aside>
      )}

      <Sheet open={leftOpen} onOpenChange={setLeftOpen}>
        <SheetContent side="left" className="w-[280px] p-0 sm:max-w-[280px]">
          <SheetTitle className="sr-only">导航</SheetTitle>
          {projectPanel}
        </SheetContent>
      </Sheet>

      <Sheet open={rightOpen} onOpenChange={setRightOpen}>
        <SheetContent side="right" className="w-[340px] p-0 sm:max-w-[340px]">
          <SheetTitle className="sr-only">文件</SheetTitle>
          {workspacePanel}
        </SheetContent>
      </Sheet>
    </div>
  );
}
