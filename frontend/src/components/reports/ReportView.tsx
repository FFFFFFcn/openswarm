import type {
  AccountReportPayload,
  CoverReportPayload,
  InsightReportPayload,
  ReportEnvelope,
  TitleReportPayload,
} from "@/api/types";
import { AccountReport } from "./AccountReport";
import { CoverReport } from "./CoverReport";
import { InsightReport } from "./InsightReport";
import { TitleReport } from "./TitleReport";

/**
 * Renders a report JSON envelope with the in-app design system. Returns null
 * for unknown kinds so the caller can fall back to the legacy HTML iframe.
 */
export function ReportView({ envelope }: { envelope: ReportEnvelope }) {
  let body: React.ReactNode = null;
  switch (envelope.kind) {
    case "insight":
      body = <InsightReport payload={envelope.payload as InsightReportPayload} />;
      break;
    case "title":
      body = <TitleReport payload={envelope.payload as TitleReportPayload} />;
      break;
    case "account":
      body = <AccountReport payload={envelope.payload as AccountReportPayload} />;
      break;
    case "cover":
      body = <CoverReport payload={envelope.payload as CoverReportPayload} />;
      break;
    default:
      return null;
  }
  return <div className="mx-auto w-full max-w-5xl px-6 py-8">{body}</div>;
}
