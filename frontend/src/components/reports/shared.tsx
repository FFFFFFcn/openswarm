import { useEffect, useState } from "react";
import { ImageOffIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Thousands-separated number for zh-CN report copy. */
export function fmt(value: number | undefined | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("zh-CN")
    : "0";
}

/**
 * Note cover image with a unified "暂无封面" placeholder. Broken links
 * (expired signed URLs, HEIF sources the browser cannot decode) and empty
 * URLs both degrade to the same grey placeholder via React `onError`.
 */
export function NoteCover({
  src,
  alt,
  aspect,
}: {
  src: string;
  alt: string;
  aspect: "4/3" | "3/4";
}) {
  const [failed, setFailed] = useState(false);
  // Reset when the list refreshes and this slot shows a different note.
  useEffect(() => setFailed(false), [src]);
  const ratio = aspect === "4/3" ? "aspect-[4/3]" : "aspect-[3/4]";
  if (!src || failed) {
    return (
      <div
        className={cn(
          "flex w-full flex-col items-center justify-center gap-1.5 bg-muted",
          ratio,
        )}
      >
        <ImageOffIcon className="size-5 text-ink-faint" />
        <span className="text-xs text-ink-faint">暂无封面</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn("w-full bg-muted object-cover", ratio)}
    />
  );
}

/** Report page header: eyebrow, display title, meta line. */
export function ReportHeader({
  eyebrow,
  title,
  meta,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
}) {
  return (
    <header className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
        {eyebrow}
      </span>
      <h1 className="text-2xl font-semibold text-foreground tracking-h2">
        {title}
      </h1>
      {meta ? <p className="text-[13px] text-ink-muted">{meta}</p> : null}
    </header>
  );
}

/** Hairline-bordered notice block for data-source disclaimers. */
export function ReportNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 text-[13px] leading-relaxed text-ink-secondary">
      {children}
    </div>
  );
}

/** Section wrapper with a small heading. */
export function ReportSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold text-foreground tracking-h3">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Small stat tile used in report summary rows. */
export function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3">
      <span className="text-xs text-ink-faint">{label}</span>
      <span className="text-lg font-semibold text-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}

/** Neutral tag chip (related searches, hot topics, patterns). */
export function TagChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-accent px-2 py-1 text-xs text-ink-secondary">
      {children}
    </span>
  );
}

/** External link styled per app conventions. */
export function ExtLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "text-foreground underline decoration-border underline-offset-2 transition-colors hover:decoration-foreground",
        className,
      )}
    >
      {children}
    </a>
  );
}
