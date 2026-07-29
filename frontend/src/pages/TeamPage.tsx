import { useEffect, useRef, useState } from "react";
import { PlayIcon } from "lucide-react";
import type { AccountProfile, AttachmentInfo, ChatItem, ComposerImage, PendingExternal } from "@/api/types";
import { AccountSelector } from "@/components/chat/AccountSelector";
import { Composer } from "@/components/chat/Composer";
import { ExternalCard } from "@/components/chat/ExternalCard";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { WelcomeScreen } from "@/components/chat/WelcomeScreen";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * Center column: the conversation. Only the user ↔ leader dialogue is rendered
 * here — subagent work lives in the workspace log panel. The composer sits
 * pinned at the bottom.
 */
export function TeamPage({
  modelReady,
  items,
  running,
  showWelcome,
  onSend,
  onStop,
  onContinue,
  onSubmitExternal,
  onAttach,
  attachments,
  onOpenSchedule,
  accounts,
  selectedAccount,
  onSelectAccount,
  onRefreshAccounts,
}: {
  modelReady: boolean;
  items: ChatItem[];
  running: boolean;
  showWelcome: boolean;
  onSend: (text: string, images: ComposerImage[]) => Promise<void>;
  onStop?: () => void;
  onContinue?: () => void;
  onSubmitExternal?: (external: PendingExternal, answer: string) => void;
  onAttach?: (files: File[]) => void;
  attachments?: AttachmentInfo[];
  onOpenSchedule?: () => void;
  accounts: AccountProfile[];
  selectedAccount: { id: string; name: string } | null;
  onSelectAccount: (account: { id: string; name: string } | null) => void;
  onRefreshAccounts?: () => void;
}) {
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Wrapper around the ScrollArea, used to locate the Radix viewport. */
  const scrollWrapRef = useRef<HTMLDivElement>(null);
  /** Whether auto-follow is active; scrolling away from the bottom pauses it. */
  const stickToBottomRef = useRef(true);
  /** DOM nodes of user messages, keyed by item id, for pin-to-top scrolling. */
  const userMsgEls = useRef(new Map<string, HTMLDivElement>());
  /** Id of the user message already pinned to the top (avoid re-pinning). */
  const pinnedUserMsgRef = useRef<string | null>(null);

  // Pause auto-follow while the user scrolls up to read earlier context; the
  // stream stops yanking the view down until they return near the bottom.
  useEffect(() => {
    if (showWelcome) return;
    const viewport = scrollWrapRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;
    const onScroll = () => {
      const distance =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      stickToBottomRef.current = distance < 80;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [showWelcome]);

  // When the user sends a message, pin it to the top of the viewport so the
  // focus stays on the current round (prior history scrolls away above). While
  // the leader streams its reply, follow the bottom — unless the user has
  // scrolled up to browse earlier messages.
  useEffect(() => {
    const last = items[items.length - 1];
    if (
      last &&
      last.kind === "message" &&
      last.role === "user" &&
      last.id !== pinnedUserMsgRef.current
    ) {
      pinnedUserMsgRef.current = last.id;
      stickToBottomRef.current = true;
      const el = userMsgEls.current.get(last.id);
      if (el) {
        requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
        return;
      }
    }
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [items]);

  const send = async (text: string, images: ComposerImage[] = []) => {
    if (sending) return;
    setSending(true);
    try {
      await onSend(text, images);
    } finally {
      setSending(false);
    }
  };

  // Offer a "continue" action when the leader's last reply was interrupted
  // (stopped mid-run) — the backend resumes from its persisted state.
  const lastMessage = [...items].reverse().find((item) => item.kind === "message");
  const canContinue = Boolean(
    onContinue &&
      !running &&
      lastMessage?.kind === "message" &&
      lastMessage.role === "agent" &&
      lastMessage.finishedReason === "interrupted",
  );

  return (
    <div className="flex h-full flex-col">

      {showWelcome ? (
        <WelcomeScreen
          disabled={!modelReady}
          onSend={(text) => void send(text)}
          accountSelector={
            <AccountSelector
              accounts={accounts}
              selected={selectedAccount}
              onSelect={onSelectAccount}
              onOpen={onRefreshAccounts}
            />
          }
        />
      ) : (
        <div ref={scrollWrapRef} className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-20 pb-6">
              {items.map((item) => {
                if (item.kind === "task") return null;
                if (item.role === "user") {
                  return (
                    <div
                      key={item.id}
                      className="scroll-mt-6"
                      ref={(el) => {
                        if (el) userMsgEls.current.set(item.id, el);
                        else userMsgEls.current.delete(item.id);
                      }}
                    >
                      <MessageBubble message={item} />
                    </div>
                  );
                }
                return (
                  <div key={item.id} className="flex flex-col gap-3">
                    <MessageBubble message={item} />
                    {item.external && onSubmitExternal ? (
                      <ExternalCard external={item.external} onSubmit={onSubmitExternal} />
                    ) : null}
                  </div>
                );
              })}
              {canContinue ? (
                <div className="flex justify-center">
                  <Button size="sm" variant="outline" onClick={onContinue}>
                    <PlayIcon className="size-3.5" />
                    继续执行
                  </Button>
                </div>
              ) : null}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>
        </div>
      )}

      {!showWelcome && (
        <div className="px-4 py-3">
          <div className="mx-auto w-full max-w-3xl">
            <div className="mb-1.5 flex items-center px-1">
              <AccountSelector
                accounts={accounts}
                selected={selectedAccount}
                onSelect={onSelectAccount}
                onOpen={onRefreshAccounts}
              />
            </div>
            <Composer
              disabled={!modelReady || sending}
              placeholder="请输入要求，交给蜂群来完成。"
              onSubmit={(text, images) => void send(text, images)}
              running={running}
              onStop={onStop}
              onAttach={onAttach}
              attachments={attachments}
              onOpenSchedule={onOpenSchedule}
            />
            <p className="mt-2 text-center text-[10px] text-ink-faint">
              内容由AI生成
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
