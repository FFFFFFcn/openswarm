import type { CoverNote, CoverReportPayload } from "@/api/types";
import {
  ExtLink,
  NoteCover,
  ReportHeader,
  ReportNotice,
  ReportSection,
  StatTile,
  TagChip,
  fmt,
} from "./shared";

function CoverCard({ note, index }: { note: CoverNote; index: number }) {
  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <NoteCover src={note.cover_url} alt={`${note.title}封面`} aspect="3/4" />
      <div className="flex flex-1 flex-col gap-2 p-4">
        <span className="text-xs text-ink-faint">
          #{index} · {note.source_group} · {note.published_at || "时间未知"}
        </span>
        <h3 className="text-sm font-semibold leading-snug text-foreground">
          {note.note_url ? (
            <ExtLink href={note.note_url}>{note.title}</ExtLink>
          ) : (
            note.title
          )}
        </h3>
        <p className="text-xs text-ink-muted">
          {note.author_url ? (
            <ExtLink href={note.author_url}>{note.author_name}</ExtLink>
          ) : (
            note.author_name
          )}
          {" · 粉丝 "}
          {fmt(note.author_fans)}
        </p>
        <p className="mt-auto text-xs tabular-nums text-ink-secondary">
          {fmt(note.interaction_count)} 互动 · {fmt(note.liked_count)} 赞 ·{" "}
          {fmt(note.collected_count)} 藏 · {fmt(note.comments_count)} 评 ·{" "}
          {fmt(note.shared_count)} 转
        </p>
      </div>
    </article>
  );
}

/** Hot-cover reference gallery rendered with app design tokens. */
export function CoverReport({ payload }: { payload: CoverReportPayload }) {
  const keyword = payload.keyword || "全站热门";
  const categories = Object.entries(payload.category_counts ?? {});
  return (
    <div className="flex flex-col gap-6">
      <ReportHeader
        eyebrow="COVER · 爆款封面"
        title={keyword}
        meta={`近 ${payload.window_days} 天 · 共 ${fmt(payload.total_samples)} 条去重样本，展示 ${payload.items.length} 条`}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="去重样本" value={fmt(payload.total_samples)} />
        <StatTile label="展示条数" value={String(payload.items.length)} />
        <StatTile label="样本窗口" value={`近 ${payload.window_days} 天`} />
      </div>
      {categories.length ? (
        <div className="flex flex-wrap gap-1.5">
          {categories.map(([label, count]) => (
            <TagChip key={label}>
              {label} {count}
            </TagChip>
          ))}
        </div>
      ) : null}
      <ReportNotice>{payload.data_notice}</ReportNotice>
      <ReportSection title="封面参考">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {payload.items.map((note, index) => (
            <CoverCard
              key={note.note_id || index}
              note={note}
              index={index + 1}
            />
          ))}
        </div>
      </ReportSection>
    </div>
  );
}
