import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  FlameIcon,
  ImageIcon,
  LightbulbIcon,
  PenLineIcon,
  TargetIcon,
  TrendingUpIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import logoUrl from "@/assets/logo.png";
import { SendButton } from "./SendButton";

interface Suggestion {
  icon: typeof FlameIcon;
  title: string;
  prompt: string;
}

const suggestions: Suggestion[] = [
  {
    icon: FlameIcon,
    title: "爆款洞察",
    prompt: "分析 AI 效率工具赛道近 7 天的爆款笔记，总结可复用的套路",
  },
  {
    icon: TargetIcon,
    title: "账号对标",
    prompt: "对标同赛道头部账号，拆解他们的内容策略与差异化机会",
  },
  {
    icon: LightbulbIcon,
    title: "选题策划",
    prompt: "结合近期热点，帮我策划 5 个小红书选题并说明理由",
  },
  {
    icon: PenLineIcon,
    title: "内容创作",
    prompt: "写一篇种草笔记，并给出标题与封面设计建议",
  },
  {
    icon: ImageIcon,
    title: "封面设计",
    prompt: "为我的笔记生成一张高点击率的小红书封面图",
  },
  {
    icon: TrendingUpIcon,
    title: "数据复盘",
    prompt: "复盘近 30 天笔记数据表现，给出下一步优化方向",
  },
];

/**
 * Welcome / new-conversation screen: centered brand header, an inline task
 * input, and a 3×2 grid of quick-start suggestion cards.
 */
export function WelcomeScreen({
  disabled,
  onSend,
  accountSelector,
}: {
  disabled?: boolean;
  onSend: (text: string) => void;
  accountSelector?: ReactNode;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText("");
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    if (event.nativeEvent.isComposing || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-[12vh] pb-10">
      {/* Brand header */}
      <div className="flex flex-col items-center">
        <img src={logoUrl} alt="蜂群引力AI" className="h-12" />
        <p className="mt-3 text-sm text-ink-muted">你的自媒体运营好帮手</p>
      </div>

      {/* Task input */}
      <div className="mt-8 w-full max-w-[680px]">
        <div className="rounded-xl bg-card p-4">
          <textarea
            ref={inputRef}
            rows={2}
            value={text}
            disabled={disabled}
            placeholder="请输入任务，交给我来帮你完成"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-ink-faint disabled:cursor-not-allowed"
          />
          <div className="mt-3 flex items-center justify-between gap-2">
            {accountSelector ?? <span />}
            <SendButton disabled={!canSend} onClick={submit} />
          </div>
        </div>
      </div>

      {/* Suggestion cards */}
      <div className="mt-8 grid w-full max-w-[680px] grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {suggestions.map((suggestion) => {
          const Icon = suggestion.icon;
          return (
            <button
              key={suggestion.title}
              type="button"
              disabled={disabled}
              onClick={() => onSend(suggestion.prompt)}
              className={cn(
                "group flex flex-col rounded-xl bg-card p-4 text-left transition-colors",
                "hover:bg-muted/70",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card",
              )}
            >
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-ink-secondary",
                )}
              >
                <Icon className="size-[18px]" />
              </span>
              <span className="mt-2.5 text-sm font-semibold text-foreground">
                {suggestion.title}
              </span>
              <span className="mt-1 line-clamp-2 text-[13px] leading-snug text-ink-muted">
                {suggestion.prompt}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
