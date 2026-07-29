import { useEffect, useRef, useState } from "react";
import { AlarmClockIcon, ImageIcon, Loader2Icon, PaperclipIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import type { AttachmentInfo, ComposerImage } from "@/api/types";
import { SendButton } from "./SendButton";

/** Cap for one pasted/picked image's base64 payload (≈2MB binary). */
const MAX_IMAGE_CHARS = 2_800_000;
const MAX_IMAGES = 4;

/** Read a picked/pasted image file into a staged composer image. */
function readImage(file: File): Promise<ComposerImage | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === "string" ? reader.result : "";
      const comma = src.indexOf(",");
      const data = comma >= 0 ? src.slice(comma + 1) : "";
      if (!data || data.length > MAX_IMAGE_CHARS) {
        resolve(null);
        return;
      }
      resolve({ id: crypto.randomUUID(), mediaType: file.type || "image/png", data, src });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

const attachmentStatusLabels: Record<AttachmentInfo["status"], string> = {
  uploading: "上传中",
  pending: "排队中",
  processing: "索引中",
  completed: "已就绪",
  failed: "失败",
};

/**
 * Auto-growing message composer. Enter submits, Shift+Enter inserts a
 * newline, and IME composition (e.g. Chinese input) is respected so Enter
 * during composition does not send prematurely. Supports pasted/picked
 * images, document attachments (RAG) and a scheduled-task entry. While a
 * task is running the composer stays usable — sending then steers the
 * running agents — and a stop button appears alongside.
 */
export function Composer({
  disabled,
  placeholder,
  onSubmit,
  running,
  onStop,
  onAttach,
  attachments,
  onOpenSchedule,
}: {
  disabled?: boolean;
  placeholder?: string;
  onSubmit: (text: string, images: ComposerImage[]) => void;
  running?: boolean;
  onStop?: () => void;
  onAttach?: (files: File[]) => void;
  attachments?: AttachmentInfo[];
  onOpenSchedule?: () => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const addImages = async (files: File[]) => {
    const pictures = files.filter((file) => file.type.startsWith("image/"));
    if (pictures.length === 0) return;
    const loaded = await Promise.all(pictures.map(readImage));
    const valid = loaded.filter((image): image is ComposerImage => image !== null);
    if (valid.length < loaded.length) toast.error("部分图片过大或无法读取（上限约 2MB）");
    setImages((prev) => {
      const next = [...prev, ...valid];
      if (next.length > MAX_IMAGES) toast.error(`最多附带 ${MAX_IMAGES} 张图片`);
      return next.slice(0, MAX_IMAGES);
    });
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void addImages(files);
  };

  const submit = () => {
    const value = text.trim();
    if ((!value && images.length === 0) || disabled) return;
    onSubmit(value, images);
    setText("");
    setImages([]);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    if (event.nativeEvent.isComposing || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  const canSend = (text.trim().length > 0 || images.length > 0) && !disabled;
  const showStop = Boolean(running && onStop);

  return (
    <div className="rounded-xl bg-card p-2">
      {attachments?.length ? (
        <div className="flex flex-wrap gap-1.5 px-2 pb-1.5">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              title={attachment.error}
              className={`inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] ${attachment.status === "failed" ? "text-red-500" : "text-ink-muted"}`}
            >
              {attachment.status === "uploading" || attachment.status === "pending" || attachment.status === "processing" ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <PaperclipIcon className="size-3" />
              )}
              {attachment.filename} · {attachmentStatusLabels[attachment.status]}
            </span>
          ))}
        </div>
      ) : null}

      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2 pb-1.5">
          {images.map((image) => (
            <div key={image.id} className="relative">
              <img src={image.src} alt="" className="size-14 rounded-md border border-border object-cover" />
              <button
                type="button"
                aria-label="移除图片"
                onClick={() => setImages((prev) => prev.filter((entry) => entry.id !== image.id))}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground p-0.5 text-background transition-opacity hover:opacity-80"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={running ? "任务执行中，可随时插话补充要求…" : placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          className="max-h-40 min-h-[72px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed outline-none placeholder:text-ink-faint disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-1">
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              void addImages(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <button
            type="button"
            title="添加图片"
            disabled={disabled}
            onClick={() => imageInputRef.current?.click()}
            className="rounded-lg p-2 text-ink-muted transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ImageIcon className="size-4" />
          </button>
          {onAttach ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length) onAttach(files);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                title="上传参考资料（RAG）"
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
                className="rounded-lg p-2 text-ink-muted transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <PaperclipIcon className="size-4" />
              </button>
            </>
          ) : null}
          {onOpenSchedule ? (
            <button
              type="button"
              title="定时任务"
              disabled={disabled}
              onClick={onOpenSchedule}
              className="rounded-lg p-2 text-ink-muted transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <AlarmClockIcon className="size-4" />
            </button>
          ) : null}
          {showStop ? <SendButton mode="stop" onClick={() => onStop?.()} /> : null}
          <SendButton disabled={!canSend} onClick={submit} />
        </div>
      </div>
    </div>
  );
}
