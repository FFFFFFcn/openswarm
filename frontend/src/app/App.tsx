import { lazy, Suspense, useCallback, useState } from "react";
import { toast } from "sonner";
import type { ComposerImage, PageKey, PendingExternal } from "@/api/types";
import { AppShell } from "@/components/AppShell";
import { SchedulePanel } from "@/components/chat/SchedulePanel";
import { ModelConfigDialog } from "@/components/ModelConfigDialog";
import {
  isOnboarded,
  OnboardingWizard,
} from "@/components/OnboardingWizard";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentTeam } from "@/hooks/useAgentTeam";

const TeamPage = lazy(() =>
  import("@/pages/TeamPage").then((module) => ({ default: module.TeamPage })),
);
const AssetsPage = lazy(() =>
  import("@/pages/AssetsPage").then((module) => ({
    default: module.AssetsPage,
  })),
);
const AccountsPage = lazy(() =>
  import("@/pages/AccountsPage").then((module) => ({
    default: module.AccountsPage,
  })),
);
const AdminPage = lazy(() =>
  import("@/pages/AdminPage").then((module) => ({
    default: module.AdminPage,
  })),
);

const validPages = new Set<PageKey>(["team", "accounts", "assets", "settings", "admin"]);
function initialPage(): PageKey {
  const value = window.location.hash.slice(1) as PageKey;
  return validPages.has(value) && value !== "settings" ? value : "team";
}

export function EditorApp() {
  const [page, setPage] = useState<PageKey>(initialPage);
  const [showOnboarding, setShowOnboarding] = useState(() => !isOnboarded());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const team = useAgentTeam();

  const navigate = useCallback((next: PageKey) => {
    if (next === "settings") {
      setSettingsOpen(true);
      return;
    }
    setPage(next);
  }, []);

  const send = useCallback(
    async (text: string, images: ComposerImage[] = []) => {
      try {
        await team.sendMessage(text, images);
      } catch (reason) {
        toast.error(reason instanceof Error ? reason.message : "无法开始任务");
      }
    },
    [team],
  );

  const continueRun = useCallback(() => {
    void team
      .continueRun()
      .catch((reason) =>
        toast.error(reason instanceof Error ? reason.message : "无法继续任务"),
      );
  }, [team]);

  const submitExternal = useCallback(
    (external: PendingExternal, answer: string) => {
      void team
        .submitExternal(external, answer)
        .catch((reason) =>
          toast.error(reason instanceof Error ? reason.message : "提交失败"),
        );
    },
    [team],
  );

  const attachFiles = useCallback(
    (files: File[]) => {
      void team
        .attachFiles(files)
        .catch((reason) =>
          toast.error(reason instanceof Error ? reason.message : "附件处理失败"),
        );
    },
    [team],
  );

  const stop = useCallback(() => {
    void team
      .stopTask()
      .then(() => toast.info("已请求停止当前任务"))
      .catch((reason) =>
        toast.error(reason instanceof Error ? reason.message : "停止失败"),
      );
  }, [team]);

  const newConversation = useCallback(() => {
    if (!team.model) {
      setSettingsOpen(true);
      return;
    }
    void team.newConversation();
    setPage("team");
  }, [team]);

  const selectConversation = useCallback(
    (id: string) => {
      team.selectConversation(id);
      setPage("team");
    },
    [team],
  );

  // Hidden admin console: standalone page opened in a new tab via #admin,
  // rendered without the AppShell chrome. Placed after all hooks to keep
  // the hook order stable.
  if (page === "admin") {
    return (
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 p-6">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        }
      >
        <AdminPage />
      </Suspense>
    );
  }

  const content =
    page === "accounts" ? (
      <AccountsPage />
    ) : page === "assets" ? (
      <AssetsPage artifacts={team.artifacts} onDeleted={team.refreshArtifacts} />
    ) : (
      <TeamPage
        modelReady={Boolean(team.model)}
        items={team.items}
        running={team.running}
        showWelcome={team.viewingId === null}
        onSend={send}
        onStop={team.running ? stop : undefined}
        onContinue={continueRun}
        onSubmitExternal={submitExternal}
        onAttach={attachFiles}
        attachments={team.attachments}
        onOpenSchedule={() => setScheduleOpen(true)}
        accounts={team.accounts}
        selectedAccount={team.selectedAccount}
        onSelectAccount={team.setSelectedAccount}
        onRefreshAccounts={() => void team.refreshAccounts()}
      />
    );

  return (
    <AppShell
      page={page}
      onNavigate={navigate}
      conversations={team.conversations}
      viewingId={team.viewingId}
      runningIds={team.runningIds}
      artifacts={team.viewingArtifacts}
      items={team.items}
      onSelectConversation={selectConversation}
      onNewConversation={newConversation}
      onDeleteConversation={(id) => void team.deleteConversation(id)}
      onPinConversation={team.pinConversation}
      onRenameConversation={team.renameConversation}
    >
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 p-6">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        }
      >
        {content}
      </Suspense>

      {showOnboarding && (
        <OnboardingWizard
          onSaveModel={team.setModel}
          onSendTask={send}
          onClose={() => setShowOnboarding(false)}
        />
      )}

      <ModelConfigDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSave={team.setModel}
        current={team.model}
      />

      <SchedulePanel
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        getContext={team.getScheduleContext}
      />
    </AppShell>
  );
}
