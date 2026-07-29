import { useCallback, useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { adminApi, type AdminRedFoxKey } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteButton, SectionHeader } from "./shared";

const SOURCE_LABELS: Record<string, string> = {
  stored: "管理后台配置",
  env: "环境变量 (.env)",
};

/**
 * Data API key management. The key saved here is persisted on
 * disk and takes effect immediately (it overrides the key from
 * the env file); clearing it falls back to the env value if one exists.
 */
export function RedFoxKeySection() {
  const [state, setState] = useState<AdminRedFoxKey | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setConfirmingClear(false);
    try {
      setState(await adminApi.redfoxKey());
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSave = async () => {
    const value = draft.trim();
    if (value.length < 8) {
      toast.error("密钥长度至少 8 位");
      return;
    }
    setSaving(true);
    try {
      setState(await adminApi.redfoxKeyUpdate(value));
      setDraft("");
      toast.success("密钥已保存，立即生效");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }
    setClearing(true);
    try {
      setState(await adminApi.redfoxKeyDelete());
      toast.success("已清除后台配置的密钥");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "清除失败");
    } finally {
      setClearing(false);
      setConfirmingClear(false);
    }
  };

  return (
    <div>
      <SectionHeader
        title="数据接口"
        description="配置小红书数据接口密钥，保存后立即生效，无需重启。"
      />
      <div className="rounded-lg bg-card p-4">
        <p className="text-xs font-medium text-ink-muted">当前状态</p>
        <div className="mt-2 flex items-center gap-2.5">
          {state?.configured ? (
            <>
              <Badge className="text-[11px]">已配置</Badge>
              <span className="font-mono text-xs text-ink-muted">
                {state.api_key_masked || "—"}
              </span>
              {state.source && (
                <span className="text-[11px] text-ink-faint">
                  来源：{SOURCE_LABELS[state.source] ?? state.source}
                </span>
              )}
            </>
          ) : (
            <Badge variant="secondary" className="text-[11px]">
              {loading ? "加载中…" : "未配置"}
            </Badge>
          )}
        </div>
        {state?.source === "stored" && (
          <div className="mt-3">
            <ConfirmDeleteButton
              confirming={confirmingClear}
              busy={clearing}
              onClick={() => void handleClear()}
              label="清除后台密钥"
            />
            <p className="mt-1 text-[11px] text-ink-faint">
              清除后回退到环境变量中的密钥（若有）。
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 rounded-lg bg-card p-4">
        <p className="text-xs font-medium text-ink-muted">
          {state?.configured ? "更换密钥" : "设置密钥"}
        </p>
        <div className="mt-2 flex gap-2">
          <input
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="粘贴数据接口密钥"
            autoComplete="off"
            spellCheck={false}
            className="h-8 flex-1 rounded-md border border-border/60 bg-background px-2.5 font-mono text-xs text-foreground outline-none transition-colors focus:border-ring"
          />
          <Button
            size="sm"
            className="h-8 px-3 text-xs"
            disabled={saving || draft.trim().length === 0}
            onClick={() => void handleSave()}
          >
            {saving && <Loader2Icon className="size-3.5 animate-spin" />}
            保存
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">
          密钥以明文保存在本机数据目录（单用户本地实例），仅用于调用数据接口。
        </p>
      </div>
    </div>
  );
}
