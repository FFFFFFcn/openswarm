import type { InsightNote, InsightReportPayload } from "@/api/types";
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

function NoteCard({ note, index }: { note: InsightNote; index: number }) {
  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <NoteCover src={note.cover_url} alt={`${note.title}封面`} aspect="4/3" />
      <div className="flex flex-1 flex-col gap-2 p-4">
        <span className="text-xs text-ink-faint">
          #{index} · {note.created_at || "时间未知"}
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
        <p className="text-xs tabular-nums text-ink-secondary">
          {fmt(note.interactive_count)} 互动 · {fmt(note.liked_count)} 赞 ·{" "}
          {fmt(note.collected_count)} 藏 · {fmt(note.comments_count)} 评 ·{" "}
          {fmt(note.shared_count)} 转
        </p>
        {typeof note.total_score === "number" ? (
          <p className="text-xs text-ink-faint">
            相关性 {note.relevance_score ?? 0}/10 · 热度{" "}
            {note.popularity_score ?? 0}/3 · 时效 {note.recency_score ?? 0}/2 ·
            综合 {note.total_score}/15
          </p>
        ) : null}
        {note.recommendation_reason ? (
          <p className="mt-auto text-xs leading-relaxed text-ink-muted">
            {note.recommendation_reason}
          </p>
        ) : null}
      </div>
    </article>
  );
}

/** Xiaohongshu hot-note insight report rendered with app design tokens. */
export function InsightReport({ payload }: { payload: InsightReportPayload }) {
  const keyword = payload.keyword || "全站热门";
  return (
    <div className="flex flex-col gap-6">
      <ReportHeader
        eyebrow="INSIGHT · 热点洞察"
        title={keyword}
        meta={`${payload.start_date} 至 ${payload.end_date} · 共 ${fmt(payload.total)} 条结果，展示 ${payload.items.length} 条`}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="结果总数" value={fmt(payload.total)} />
        <StatTile label="展示条数" value={String(payload.items.length)} />
        <StatTile label="相关搜索" value={String(payload.related_searches.length)} />
        <StatTile label="热门话题" value={String(payload.hot_topics.length)} />
      </div>
      <ReportNotice>
        {payload.data_notice}
        {payload.sort_notice ? ` ${payload.sort_notice}` : ""}
      </ReportNotice>
      {payload.items.length ? (
        <ReportSection title="热门笔记">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {payload.items.map((note, index) => (
              <NoteCard
                key={note.note_id || index}
                note={note}
                index={index + 1}
              />
            ))}
          </div>
        </ReportSection>
      ) : null}
      {payload.latest_hot_articles.length ? (
        <ReportSection title="近期高互动推荐">
          <div className="flex flex-col gap-2">
            {payload.latest_hot_articles.map((note, index) => (
              <div
                key={note.note_id || index}
                className="flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3"
              >
                <span className="text-xs text-ink-faint">
                  推荐 #{index + 1} · {note.created_at || "时间未知"}
                </span>
                <span className="text-sm font-medium text-foreground">
                  {note.note_url ? (
                    <ExtLink href={note.note_url}>{note.title}</ExtLink>
                  ) : (
                    note.title
                  )}
                </span>
                <span className="text-xs text-ink-muted">
                  {note.author_name} · {fmt(note.interactive_count)} 互动 ·{" "}
                  {note.recommendation_reason}
                </span>
              </div>
            ))}
          </div>
        </ReportSection>
      ) : null}
      {payload.related_searches.length ? (
        <ReportSection title="相关搜索">
          <div className="flex flex-wrap gap-1.5">
            {payload.related_searches.map((item) => (
              <TagChip key={item}>{item}</TagChip>
            ))}
          </div>
        </ReportSection>
      ) : null}
      {payload.hot_topics.length ? (
        <ReportSection title="热门话题">
          <div className="flex flex-wrap gap-1.5">
            {payload.hot_topics.map((item) => (
              <TagChip key={item}>{item}</TagChip>
            ))}
          </div>
        </ReportSection>
      ) : null}
    </div>
  );
}
