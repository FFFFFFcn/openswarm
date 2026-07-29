import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ChatHint, ChatImage, ChatMessageItem } from "@/api/types";
import { finishReasonLabels, formatTokens } from "@/components/chat/meta";
import { stripAccountMarker } from "@/utils/accountMarker";

/**
 * Shared prose styling for markdown bubbles. Brand rule: markdown body never
 * drops below 15px for CJK readability — the container is set to 15px and the
 * elements typography would otherwise shrink (code/pre/table cells) are pinned
 * back up to 15px.
 */
const markdownClass =
  "prose max-w-none break-words text-[15px] prose-headings:tracking-tight prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-code:text-[15px] prose-code:text-ink-secondary prose-pre:bg-muted prose-pre:text-[15px] prose-pre:text-foreground prose-th:text-[15px] prose-td:text-[15px] prose-figcaption:text-[15px] prose-small:text-[15px]";

/** Copy-to-clipboard icon button with a transient "copied" check state. */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const Icon = copied ? CheckIcon : CopyIcon;
  return (
    <button
      type="button"
      aria-label="复制消息"
      title="复制"
      onClick={copy}
      className={`rounded p-1 text-ink-faint transition-colors hover:bg-muted hover:text-ink-secondary ${className ?? ""}`}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function ImageStrip({ images, maxHeight = "max-h-64" }: { images: ChatImage[]; maxHeight?: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((image) => (
        <img
          key={image.blockId}
          src={image.src}
          alt=""
          loading="lazy"
          className={`${maxHeight} rounded-md border border-border object-contain`}
        />
      ))}
    </div>
  );
}

/** One-shot hint notice (team message / background result) inside a bubble. */
function HintNotice({ hint }: { hint: ChatHint }) {
  return (
    <div className="rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-[12px] leading-relaxed text-ink-muted">
      {hint.source ? (
        <span className="mr-1 font-medium text-ink-secondary">{hint.source}：</span>
      ) : null}
      <span className="whitespace-pre-wrap break-words">{hint.text}</span>
      {hint.images?.length ? (
        <div className="mt-1.5">
          <ImageStrip images={hint.images} maxHeight="max-h-40" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A single chat message. User messages are right-aligned gray bubbles; the
 * leader's messages are left-aligned white bubbles with no avatar or name —
 * the conversation is a focused 1-on-1 between the user and the leader.
 * Agent bubbles carry the full reply anatomy: a collapsible thinking stream,
 * hint notices, markdown body, inline images and a meta footer (abnormal
 * finish badge + token usage).
 */
export function MessageBubble({ message }: { message: ChatMessageItem }) {
  const isUser = message.role === "user";

  if (isUser) {
    // Defensive: never render the account marker line even if it leaked into
    // an archived/replayed user message.
    const userText = stripAccountMarker(message.text);
    return (
      <div className="group flex flex-col items-end">
        {message.aside ? (
          <span className="mb-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-ink-faint">
            运行中插话
          </span>
        ) : null}
        <div className="max-w-[78%] rounded-xl rounded-br-xs bg-muted px-4 py-3 text-[15px] leading-relaxed text-foreground">
          {message.images?.length ? (
            <div className={userText ? "mb-2" : undefined}>
              <ImageStrip images={message.images} maxHeight="max-h-40" />
            </div>
          ) : null}
          {userText ? (
            <p className="whitespace-pre-wrap break-words">{userText}</p>
          ) : null}
        </div>
        {userText ? (
          <CopyButton
            text={userText}
            className="mt-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          />
        ) : null}
      </div>
    );
  }

  const hasThinking = Boolean(message.thinking);
  // While the model is still reasoning (no visible text yet) the thinking
  // stream is shown expanded; once the answer lands it collapses out of the way.
  const thinkingLive = Boolean(message.streaming) && message.text.length === 0;
  const showTyping = thinkingLive && !hasThinking;
  const reasonLabel = message.finishedReason ? finishReasonLabels[message.finishedReason] : undefined;
  const usage = message.usage;
  const showUsage = !message.streaming && usage && usage.inputTokens + usage.outputTokens > 0;
  const canCopy = !message.streaming && message.text.length > 0;

  return (
    <div className="max-w-[78%] rounded-xl rounded-tl-xs bg-card px-4 py-3 text-[15px] leading-relaxed text-foreground">
      {hasThinking ? (
        <details className="mb-2" open={thinkingLive}>
          <summary className="cursor-pointer select-none text-xs text-ink-faint transition-colors hover:text-ink-muted">
            思考过程
          </summary>
          <div className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-[13px] leading-relaxed text-ink-muted">
            {message.thinking}
          </div>
        </details>
      ) : null}

      {message.hints?.length ? (
        <div className="mb-2 flex flex-col gap-1.5">
          {message.hints.map((hint, index) => (
            <HintNotice key={hint.blockId ?? index} hint={hint} />
          ))}
        </div>
      ) : null}

      {showTyping ? (
        <span className="text-ink-faint">正在思考…</span>
      ) : message.text ? (
        <div className={markdownClass}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
        </div>
      ) : null}

      {message.images?.length ? (
        <div className="mt-2">
          <ImageStrip images={message.images} />
        </div>
      ) : null}

      {reasonLabel || showUsage || canCopy ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
          {reasonLabel ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-ink-muted">{reasonLabel}</span>
          ) : null}
          {showUsage ? (
            <span>
              {usage.modelName ? `${usage.modelName} · ` : ""}
              ↑{formatTokens(usage.inputTokens)} ↓{formatTokens(usage.outputTokens)} tokens
            </span>
          ) : null}
          {canCopy ? <CopyButton text={message.text} className="-my-1 ml-auto" /> : null}
        </div>
      ) : null}
    </div>
  );
}
