import { useEffect, useState } from "react";
import { artifactsApi } from "@/api/client";
import type { Artifact, ReportEnvelope } from "@/api/types";
import { ReportView } from "@/components/reports/ReportView";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

const KNOWN_KINDS = new Set(["insight", "title", "account", "cover"]);

/**
 * Shared artifact preview body: artifacts with a JSON data sibling render
 * natively with the app design system (ReportView); legacy HTML-only
 * artifacts — or any data fetch/kind failure — fall back to the sandboxed
 * iframe. Used by both the workspace preview tab and the asset library.
 */
export function ArtifactPreview({ artifact }: { artifact: Artifact }) {
  const [envelope, setEnvelope] = useState<ReportEnvelope | null>(null);
  const [loading, setLoading] = useState(false);
  const [dataFailed, setDataFailed] = useState(false);

  // Fetch the JSON envelope for natively renderable artifacts; any failure
  // degrades to the legacy iframe preview.
  useEffect(() => {
    setEnvelope(null);
    setDataFailed(false);
    if (!artifact.has_data) return;
    let cancelled = false;
    setLoading(true);
    artifactsApi
      .data(artifact.id)
      .then((data) => {
        if (!cancelled) setEnvelope(data);
      })
      .catch(() => {
        if (!cancelled) setDataFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, artifact.has_data]);

  const nativeView =
    envelope && KNOWN_KINDS.has(envelope.kind) ? envelope : null;
  const useIframe =
    !loading && !nativeView && (!artifact.has_data || dataFailed || envelope != null);

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-10 py-8">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-96" />
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="mt-4 h-40" />
      </div>
    );
  }
  if (nativeView) {
    return (
      <ScrollArea className="min-h-0 flex-1 bg-background">
        <ReportView envelope={nativeView} />
      </ScrollArea>
    );
  }
  if (useIframe) {
    return (
      <iframe
        title={artifact.name}
        src={`/api/v1/artifacts/${artifact.id}`}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    );
  }
  return null;
}
