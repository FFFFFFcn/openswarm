import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { adminApi, formatDate, type AdminCredential } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { ConfirmDeleteButton, SectionHeader } from "./shared";

/**
 * Model credential management: masked listing plus two-step confirmed
 * deletion. Removal only rewrites the local vault file — the running
 * in-memory copy disappears after the next backend restart.
 */
export function CredentialsSection() {
  const [items, setItems] = useState<AdminCredential[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setConfirmingId(null);
    try {
      setItems(await adminApi.credentials());
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = async (id: string) => {
    if (confirmingId !== id) {
      setConfirmingId(id);
      return;
    }
    setBusyId(id);
    try {
      await adminApi.credentialDelete(id);
      toast.success("凭据已删除，重启后彻底失效");
      await refresh();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  };

  return (
    <div>
      <SectionHeader
        title="模型凭据"
        description="删除仅移除本地保管库记录；运行中的凭据需重启后端才彻底失效。"
      />
      {items.length ? (
        <div className="overflow-hidden rounded-lg bg-card">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-xs text-ink-muted">
                <th className="px-3 py-2 font-medium">名称</th>
                <th className="w-32 px-3 py-2 font-medium">类型</th>
                <th className="w-36 px-3 py-2 font-medium">密钥</th>
                <th className="w-28 px-3 py-2 font-medium">创建时间</th>
                <th className="w-28 px-3 py-2 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-border/60">
                  <td className="max-w-0 truncate px-3 py-2 text-foreground">
                    {item.name ?? item.id}
                    {item.base_url && (
                      <span className="ml-2 text-xs text-ink-faint">
                        {item.base_url}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary" className="text-[11px]">
                      {item.type ?? "unknown"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-ink-muted">
                    {item.api_key_masked || "—"}
                  </td>
                  <td className="px-3 py-2 text-ink-muted">
                    {formatDate(item.created_at)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ConfirmDeleteButton
                      confirming={confirmingId === item.id}
                      busy={busyId === item.id}
                      onClick={() => void handleDelete(item.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-ink-faint">
          {loading ? "加载中…" : "暂无凭据"}
        </p>
      )}
    </div>
  );
}
