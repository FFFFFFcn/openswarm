import type { AccountReportPayload, BenchmarkAccount } from "@/api/types";
import {
  ExtLink,
  ReportHeader,
  ReportNotice,
  ReportSection,
  StatTile,
  fmt,
} from "./shared";

function AccountTable({
  title,
  accounts,
}: {
  title: string;
  accounts: BenchmarkAccount[];
}) {
  return (
    <ReportSection title={title}>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-ink-faint">
              <th className="px-4 py-2.5 font-medium">账号</th>
              <th className="px-4 py-2.5 font-medium">等级</th>
              <th className="px-4 py-2.5 font-medium">粉丝</th>
              <th className="px-4 py-2.5 font-medium">近30天互动</th>
              <th className="px-4 py-2.5 font-medium">近7天活跃</th>
              <th className="px-4 py-2.5 font-medium">30天互动/粉丝</th>
              <th className="px-4 py-2.5 font-medium">内容分析与推荐理由</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length ? (
              accounts.map((account, index) => (
                <tr
                  key={account.account_id || account.profile_url || index}
                  className="border-b border-border align-top last:border-b-0"
                >
                  <td className="px-4 py-2.5 font-medium text-foreground">
                    {account.profile_url ? (
                      <ExtLink href={account.profile_url}>
                        {account.nickname}
                      </ExtLink>
                    ) : (
                      account.nickname
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-ink-secondary">
                    {account.level || "--"}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                    {fmt(account.fans)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                    {fmt(account.interactive_30)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                    {account.notes_7} 篇 / {fmt(account.interactive_7)} 互动
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                    {(account.interaction_fan_ratio_30 / 100).toFixed(2)} 倍
                  </td>
                  <td className="max-w-[280px] px-4 py-2.5 text-ink-secondary">
                    {account.content_analysis}
                    <span className="mt-0.5 block text-xs text-ink-faint">
                      {account.recommendation_reason}
                    </span>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-6 text-center text-ink-faint"
                >
                  暂无匹配账号
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </ReportSection>
  );
}

/** Account benchmark report rendered with app design tokens. */
export function AccountReport({ payload }: { payload: AccountReportPayload }) {
  const criteria = payload.criteria;
  const criteriaText =
    criteria.query_mode === "red_id"
      ? `账号 ID：${criteria.red_id ?? "--"}`
      : [
          `赛道：${criteria.track || "综合全部"}`,
          criteria.max_fans != null
            ? `粉丝：${fmt(criteria.min_fans ?? 0)}–${fmt(criteria.max_fans)}`
            : criteria.min_fans != null
              ? `粉丝：≥${fmt(criteria.min_fans)}`
              : "",
          criteria.level ? `等级：${criteria.level}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
  const summary = payload.summary;
  return (
    <div className="flex flex-col gap-6">
      <ReportHeader
        eyebrow="ACCOUNT · 账号对标"
        title="小红书账号对标报告"
        meta={`${criteriaText} · 数据入库：${payload.data_updated_at}`}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="同级账号" value={fmt(summary.same_level_count)} />
        <StatTile label="高级账号" value={fmt(summary.high_level_count)} />
        <StatTile label="KOL 候选" value={fmt(summary.kol_candidate_count)} />
        <StatTile
          label="同级平均粉丝"
          value={fmt(summary.same_level_avg_fans)}
        />
        <StatTile
          label="同级平均30天互动"
          value={fmt(summary.same_level_avg_interactive_30)}
        />
        <StatTile
          label="高级平均粉丝"
          value={fmt(summary.high_level_avg_fans)}
        />
        <StatTile
          label="高级平均30天互动"
          value={fmt(summary.high_level_avg_interactive_30)}
        />
      </div>
      <ReportNotice>{payload.data_notice}</ReportNotice>
      <AccountTable title="同级对标账号" accounts={payload.same_level_accounts} />
      <AccountTable title="高级对标账号" accounts={payload.high_level_accounts} />
      <AccountTable title="KOL 合作候选" accounts={payload.kol_candidates} />
    </div>
  );
}
