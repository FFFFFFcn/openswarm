import { useEffect, useState } from "react";
import { EyeIcon, EyeOffIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { request } from "@/api/client";
import type { ModelConfig } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const API_TYPES = [
  { value: "openai_credential", label: "OpenAI" },
  { value: "dashscope_credential", label: "DashScope" },
  { value: "deepseek_credential", label: "DeepSeek" },
  { value: "anthropic_credential", label: "Anthropic" },
  { value: "gemini_credential", label: "Gemini" },
  { value: "moonshot_credential", label: "Moonshot" },
  { value: "ollama_credential", label: "Ollama" },
  { value: "xai_credential", label: "xAI" },
];

/** Shared field style: borderless muted surface, no focus ring. */
const fieldCls = "rounded-lg px-3 py-2 text-[15px] focus-visible:ring-0";

function providerLabel(config: ModelConfig): string {
  const provider =
    config.api_type?.replace("_credential", "") ??
    config.model_type.replace("_chat", "");
  return (
    API_TYPES.find((item) => item.value === `${provider}_credential`)?.label ??
    provider
  );
}

/**
 * Model settings dialog. Acts as a management panel: when a model is already
 * configured it opens in a read-only "view" mode showing the current config,
 * with actions to edit (re-enter credentials) or remove it. When no model is
 * configured it opens directly in the "edit" form.
 */
export function ModelConfigDialog({
  open,
  onOpenChange,
  onSave,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (value: ModelConfig | null) => Promise<void>;
  current: ModelConfig | null;
}) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiType, setApiType] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [modelName, setModelName] = useState("");
  const [modelId, setModelId] = useState("");
  const [saving, setSaving] = useState(false);
  /** "确定" progresses through a connectivity test before saving. */
  const [phase, setPhase] = useState<"idle" | "testing" | "saving">("idle");
  /** Two-step removal: first click arms the confirm, second click executes. */
  const [removeConfirm, setRemoveConfirm] = useState(false);

  // Reset to the appropriate mode each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setSaving(false);
    setPhase("idle");
    setRemoveConfirm(false);
    setShowKey(false);
    if (current) {
      setMode("view");
    } else {
      setMode("edit");
      setBaseUrl("");
      setApiType("");
      setApiKey("");
      setModelName("");
      setModelId("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const startEdit = () => {
    if (current) {
      setBaseUrl(current.base_url ?? "");
      setApiType(current.api_type ?? "");
      setModelName(current.model_name ?? "");
      setModelId(current.model ?? "");
    }
    setApiKey("");
    setShowKey(false);
    setMode("edit");
  };

  const handleConfirm = async () => {
    if (!baseUrl.trim()) {
      toast.error("请输入接口地址");
      return;
    }
    if (!apiType) {
      toast.error("请选择 API 协议类型");
      return;
    }
    if (!apiKey.trim()) {
      toast.error("请输入 API Key");
      return;
    }
    if (!modelName.trim()) {
      toast.error("请输入模型名称");
      return;
    }
    if (!modelId.trim()) {
      toast.error("请输入模型 ID");
      return;
    }

    setSaving(true);
    try {
      // Probe the provider with a minimal chat call first, so a wrong
      // base URL / key / model id fails here instead of on the first task.
      setPhase("testing");
      try {
        await request("/api/v1/agent-team/model-test", {
          method: "POST",
          body: JSON.stringify({
            api_type: apiType,
            base_url: baseUrl.trim(),
            api_key: apiKey.trim(),
            model: modelId.trim(),
          }),
        });
      } catch (reason) {
        toast.error(
          reason instanceof Error
            ? `模型连接测试失败：${reason.message}`
            : "模型连接测试失败",
        );
        return;
      }

      setPhase("saving");
      const response = await request<{ credential_id: string }>("/credential/", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: apiType,
            api_key: apiKey.trim(),
            base_url: baseUrl.trim(),
          },
        }),
      });
      const providerName = apiType.replace("_credential", "");
      await onSave({
        credential_id: response.credential_id,
        model_type:
          providerName === "openai" ? "openai_chat" : `${providerName}_chat`,
        model: modelId.trim(),
        api_type: apiType,
        base_url: baseUrl.trim(),
        model_name: modelName.trim(),
      });
      onOpenChange(false);
      toast.success("模型连接测试通过，已启用，下次任务会创建新的团队会话");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "凭据保存失败");
    } finally {
      setSaving(false);
      setPhase("idle");
    }
  };

  const handleRemove = async () => {
    setSaving(true);
    try {
      await onSave(null);
      onOpenChange(false);
      toast.success("已移除当前模型配置");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "移除失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 rounded-2xl p-6 sm:max-w-[480px]">
        {mode === "view" && current ? (
          <>
            <DialogHeader className="mb-6">
              <DialogTitle className="text-[16px] font-semibold text-foreground">
                模型设置
              </DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-1.5">
              <ConfigRow label="服务商" value={providerLabel(current)} />
              <ConfigRow
                label="模型名称"
                value={current.model_name || current.model}
              />
              <ConfigRow label="模型 ID" value={current.model} mono />
              {current.base_url ? (
                <ConfigRow label="接口地址" value={current.base_url} mono />
              ) : null}
              <ConfigRow
                label="凭据 ID"
                value={current.credential_id}
                mono
                faint
              />
            </div>

            <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
              API Key 已加密保存在服务端，出于安全不会在此展示。修改配置时需要重新输入。
            </p>

            <div className="mt-6 flex items-center justify-between gap-3">
              {removeConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-destructive">
                    确认移除？
                  </span>
                  <Button
                    variant="destructive"
                    onClick={() => void handleRemove()}
                    disabled={saving}
                    className="rounded-full px-4 text-[14px]"
                  >
                    <Trash2Icon className="size-4" />
                    确认移除
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setRemoveConfirm(false)}
                    disabled={saving}
                    className="rounded-full bg-muted px-4 text-[14px] text-ink-secondary"
                  >
                    取 消
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => setRemoveConfirm(true)}
                  disabled={saving}
                  className="rounded-full bg-muted px-4 text-[14px] text-ink-secondary"
                >
                  <Trash2Icon className="size-4" />
                  移除模型
                </Button>
              )}
              <div className="flex gap-3">
                <Button
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  className="rounded-full bg-muted px-5 text-[14px] text-ink-secondary"
                >
                  关 闭
                </Button>
                <Button
                  onClick={startEdit}
                  className="rounded-full px-5 text-[14px]"
                >
                  <PencilIcon className="size-4" />
                  修改配置
                </Button>
              </div>
            </div>
          </>
        ) : (
          <>
            <DialogHeader className="mb-6">
              <DialogTitle className="text-[16px] font-semibold text-foreground">
                {current ? "修改模型配置" : "添加自定义大模型"}
              </DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              {/* 接口地址 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[14px] text-ink-muted">接口地址：</label>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="请输入 API 基础地址"
                  className={fieldCls}
                />
              </div>

              {/* API 协议类型 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[14px] text-ink-muted">API 协议类型：</label>
                <Select value={apiType} onValueChange={setApiType}>
                  <SelectTrigger className={`${fieldCls} text-ink-muted`}>
                    <SelectValue placeholder="请选择 API 类型" />
                  </SelectTrigger>
                  <SelectContent>
                    {API_TYPES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* API Key */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[14px] text-ink-muted">API Key：</label>
                <div className="relative">
                  <Input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      current ? "出于安全需重新输入 API Key" : "请输入 API Key"
                    }
                    className={`${fieldCls} pr-10`}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink-muted"
                    aria-label={showKey ? "隐藏" : "显示"}
                  >
                    {showKey ? (
                      <EyeOffIcon className="size-4" />
                    ) : (
                      <EyeIcon className="size-4" />
                    )}
                  </button>
                </div>
              </div>

              {/* 模型名称 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[14px] text-ink-muted">模型名称：</label>
                <Input
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  placeholder="请输入，如 doubao seed 2.0 code preview"
                  className={fieldCls}
                />
              </div>

              {/* 模型 ID */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[14px] text-ink-muted">模型 ID：</label>
                <Input
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="输入模型官方提供的ID，如 doubao-seed-2，请勿随意填写"
                  className={fieldCls}
                />
              </div>
            </div>

            {/* Footer */}
            <div className="mt-6 flex justify-end gap-3">
              <Button
                variant="ghost"
                onClick={() =>
                  current ? setMode("view") : onOpenChange(false)
                }
                className="rounded-full bg-muted px-5 text-[14px] text-ink-secondary"
              >
                取 消
              </Button>
              <Button
                onClick={() => void handleConfirm()}
                disabled={saving}
                className="rounded-full px-5 text-[14px]"
              >
                {phase === "testing"
                  ? "测试连接中…"
                  : phase === "saving"
                    ? "保存中…"
                    : "确 定"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A single read-only label/value row used in the view mode. */
function ConfigRow({
  label,
  value,
  mono,
  faint,
}: {
  label: string;
  value: string;
  mono?: boolean;
  faint?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg bg-muted px-4 py-3">
      <span className="shrink-0 text-[13px] text-ink-faint">{label}</span>
      <span
        className={
          "min-w-0 break-all text-right text-[14px] " +
          (mono ? "font-mono text-[13px] " : "") +
          (faint ? "text-ink-faint" : "text-foreground")
        }
      >
        {value}
      </span>
    </div>
  );
}
