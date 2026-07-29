import { useState } from "react";
import { MessageCircleQuestionIcon } from "lucide-react";
import type { PendingExternal } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** Parsed payload of one `ask_user` external tool call. */
function parseQuestion(input: string): { question: string; context?: string } {
  try {
    const args = JSON.parse(input) as { question?: string; context?: string };
    return { question: args.question ?? "需要你补充一些信息。", context: args.context };
  } catch {
    return { question: input || "需要你补充一些信息。" };
  }
}

/**
 * External-execution card: the run is parked on an `ask_user` tool call and
 * resumes once the user submits an answer. Mirrors ConfirmCard's styling.
 */
export function ExternalCard({
  external,
  onSubmit,
}: {
  external: PendingExternal;
  onSubmit: (external: PendingExternal, answer: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  const questions = external.toolCalls.map((call) => parseQuestion(call.input));

  return (
    <div className="rounded-xl bg-muted p-4">
      <div className="flex items-start gap-2.5">
        <MessageCircleQuestionIcon className="mt-0.5 size-4 shrink-0 text-ink-secondary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">需要你补充信息</p>
          <p className="mt-0.5 text-[13px] text-ink-muted">
            任务已暂停，回答后会自动继续执行。
          </p>
        </div>
      </div>

      <ul className="mt-3 flex flex-col gap-2">
        {questions.map((question, index) => (
          <li key={external.toolCalls[index]?.id ?? index} className="rounded-lg bg-card px-3 py-2 text-[13px]">
            <p className="break-words font-medium text-foreground">{question.question}</p>
            {question.context ? (
              <p className="mt-1 break-words text-ink-muted">{question.context}</p>
            ) : null}
          </li>
        ))}
      </ul>

      <Textarea
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="输入你的回答…"
        className="mt-3 min-h-[72px] bg-card"
      />
      <div className="mt-3 flex justify-end">
        <Button size="sm" disabled={!answer.trim()} onClick={() => onSubmit(external, answer.trim())}>
          提交回答
        </Button>
      </div>
    </div>
  );
}
