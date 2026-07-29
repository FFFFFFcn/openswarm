import type { TitleReference, TitleReportPayload } from "@/api/types";
import {
  ExtLink,
  ReportHeader,
  ReportNotice,
  ReportSection,
  StatTile,
  TagChip,
  fmt,
} from "./shared";

function ReferenceList({ references }: { references: TitleReference[] }) {
  if (!references.length) return null;
  return (
    <ul className="flex flex-col gap-1">
      {references.map((ref, index) => (
        <li key={ref.note_id || index} className="text-xs text-ink-muted">
          参考：
          {ref.url ? <ExtLink href={ref.url}>{ref.title}</ExtLink> : ref.title}
          {" · "}
          {ref.author} · {fmt(ref.interaction_count)} 互动
        </li>
      ))}
    </ul>
  );
}

function GenerateView({ payload }: { payload: TitleReportPayload }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="候选标题" value={String(payload.titles?.length ?? 0)} />
        <StatTile label="趋势样本" value={fmt(payload.sample_count)} />
        <StatTile label="样本窗口" value={`近 ${payload.window_days ?? 30} 天`} />
      </div>
      {payload.patterns?.length ? (
        <ReportSection title="样本标题信号">
          <div className="flex flex-wrap gap-1.5">
            {payload.patterns.map((item) => (
              <TagChip key={item}>{item}</TagChip>
            ))}
          </div>
        </ReportSection>
      ) : null}
      <ReportSection title="标题候选">
        <div className="flex flex-col gap-2">
          {(payload.titles ?? []).map((item) => (
            <article
              key={item.rank}
              className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-ink-faint">#{item.rank}</span>
                <span className="text-xs tabular-nums text-ink-muted">
                  匹配指数 {item.match_score.toFixed(1)}/10
                </span>
              </div>
              <h3 className="text-base font-semibold text-foreground">
                {item.title}
              </h3>
              <p className="text-xs leading-relaxed text-ink-muted">
                {item.reason}
              </p>
              <ReferenceList references={item.references} />
            </article>
          ))}
        </div>
      </ReportSection>
    </>
  );
}

function ScoreView({ payload }: { payload: TitleReportPayload }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="综合得分" value={`${payload.score ?? 0}/10`} />
        <StatTile label="评级" value={payload.grade || "--"} />
        <StatTile label="趋势样本" value={fmt(payload.sample_count)} />
      </div>
      {payload.highlights?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {payload.highlights.map((item) => (
            <TagChip key={item}>{item}</TagChip>
          ))}
        </div>
      ) : null}
      {payload.dimensions?.length ? (
        <ReportSection title="维度评分">
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-ink-faint">
                  <th className="px-4 py-2.5 font-medium">维度</th>
                  <th className="px-4 py-2.5 font-medium">权重</th>
                  <th className="px-4 py-2.5 font-medium">得分</th>
                  <th className="px-4 py-2.5 font-medium">加权得分</th>
                </tr>
              </thead>
              <tbody>
                {payload.dimensions.map((dim) => (
                  <tr
                    key={dim.key}
                    className="border-b border-border last:border-b-0"
                  >
                    <td className="px-4 py-2.5 text-foreground">{dim.label}</td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                      {dim.weight}%
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                      {dim.score}/10
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                      {dim.weighted_score}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ReportSection>
      ) : null}
      {payload.issues?.length ? (
        <ReportSection title="待改进问题">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink-secondary">
            {payload.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </ReportSection>
      ) : null}
      {payload.rewrites?.length ? (
        <ReportSection title="改写建议">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {payload.rewrites.map((rewrite) => (
              <article
                key={rewrite.style}
                className="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-4 py-3.5"
              >
                <span className="text-xs text-ink-faint">{rewrite.style}</span>
                <h3 className="text-sm font-semibold text-foreground">
                  {rewrite.title}
                </h3>
                <p className="text-xs text-ink-muted">
                  适用：{rewrite.scene}
                </p>
                <p className="text-xs leading-relaxed text-ink-muted">
                  {rewrite.expected_effect}
                </p>
              </article>
            ))}
          </div>
        </ReportSection>
      ) : null}
      {payload.references?.length ? (
        <ReportSection title="趋势样本参考">
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <ReferenceList references={payload.references} />
          </div>
        </ReportSection>
      ) : null}
    </>
  );
}

/** Title candidate/score report rendered with app design tokens. */
export function TitleReport({ payload }: { payload: TitleReportPayload }) {
  const isGenerate = payload.mode === "generate";
  return (
    <div className="flex flex-col gap-6">
      <ReportHeader
        eyebrow="TITLE · 标题优化"
        title={
          isGenerate
            ? `「${payload.keyword}」标题候选`
            : payload.title || payload.keyword
        }
        meta={
          isGenerate
            ? `关键词「${payload.keyword}」 · 基于近 ${payload.window_days ?? 30} 天 ${payload.sample_count} 条趋势样本`
            : `关键词「${payload.keyword}」 · 标题诊断评分`
        }
      />
      {payload.sample_warning ? (
        <ReportNotice>{payload.sample_warning}</ReportNotice>
      ) : null}
      {isGenerate ? (
        <GenerateView payload={payload} />
      ) : (
        <ScoreView payload={payload} />
      )}
      <ReportNotice>
        {payload.data_notice}
        {payload.link_notice ? ` ${payload.link_notice}` : ""}
      </ReportNotice>
    </div>
  );
}
