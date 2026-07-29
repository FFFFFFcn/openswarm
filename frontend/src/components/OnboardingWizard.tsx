import { useEffect, useMemo, useState, type ComponentType } from "react";
import {
  ArrowRightIcon,
  CheckIcon,
  KeyIcon,
  RocketIcon,
  SparklesIcon,
} from "lucide-react";
import { toast } from "sonner";
import { request } from "@/api/client";
import type { CredentialSchema, JsonSchema, ModelConfig } from "@/api/types";
import {
  AnthropicIcon,
  DashscopeIcon,
  DeepSeekIcon,
  DefaultProviderIcon,
  GeminiIcon,
  MoonshotIcon,
  OllamaIcon,
  OpenAIIcon,
  XAIIcon,
} from "@/components/icons/ProviderIcons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ONBOARDED_KEY = "openswarm-onboarded";

const EXAMPLE_TASKS = [
  {
    icon: "🔍",
    label: "爆款笔记洞察",
    prompt: "分析 AI 效率工具赛道近 7 天的爆款笔记",
  },
  {
    icon: "📋",
    label: "制定起号策略",
    prompt: "根据我的账号档案，制定一份首月起号方案",
  },
  {
    icon: "💡",
    label: "生成选题卡",
    prompt: "基于账号定位，策划 5 张差异化选题卡",
  },
] as const;

const fallbackProviders = [
  "openai_credential",
  "dashscope_credential",
  "deepseek_credential",
  "anthropic_credential",
  "gemini_credential",
  "moonshot_credential",
  "ollama_credential",
  "xai_credential",
];

type IconComponent = ComponentType<{ className?: string }>;

const PROVIDER_ICONS: Record<string, IconComponent> = {
  openai: OpenAIIcon,
  dashscope: DashscopeIcon,
  deepseek: DeepSeekIcon,
  anthropic: AnthropicIcon,
  gemini: GeminiIcon,
  moonshot: MoonshotIcon,
  ollama: OllamaIcon,
  xai: XAIIcon,
};

function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  const name = provider.replace("_credential", "");
  const Icon = PROVIDER_ICONS[name] ?? DefaultProviderIcon;
  return <Icon className={className} />;
}

function providerName(key: string): string {
  return key.replace("_credential", "").toUpperCase();
}

const secretPattern = /key|token|secret|password/i;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function normalizeSchemas(raw: unknown): Record<string, CredentialSchema> {
  const source =
    raw && typeof raw === "object" && "data" in raw
      ? (raw as { data: unknown }).data
      : raw;
  const schemas =
    source && typeof source === "object" && "schemas" in source
      ? (source as { schemas: unknown }).schemas
      : source;
  if (Array.isArray(schemas)) {
    return Object.fromEntries(
      schemas
        .map((item) => {
          const schema = item as CredentialSchema;
          return [
            schema.properties?.type?.const ?? schema.name ?? schema.type,
            schema,
          ] as const;
        })
        .filter(
          ([key]) => typeof key === "string" && key.endsWith("_credential"),
        ),
    );
  }
  return schemas && typeof schemas === "object"
    ? (schemas as Record<string, CredentialSchema>)
    : {};
}

function getJsonSchema(value?: CredentialSchema): JsonSchema {
  return value?.schema ?? value?.json_schema ?? value ?? {};
}

export function isOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return true; // fail-open: don't block returning users
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    /* noop */
  }
}

/* ------------------------------------------------------------------ */
/*  Step indicator                                                     */
/* ------------------------------------------------------------------ */

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={
            i === current
              ? "h-2 w-6 rounded-full bg-primary transition-all"
              : "h-2 w-2 rounded-full bg-border transition-all"
          }
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function OnboardingWizard({
  onSaveModel,
  onSendTask,
  onClose,
}: {
  onSaveModel: (value: ModelConfig) => Promise<void>;
  onSendTask: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);

  /* --- Step 1: model config state --- */
  const [schemas, setSchemas] = useState<Record<string, CredentialSchema>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [provider, setProvider] = useState("openai_credential");
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    void request<unknown>("/credential/schemas")
      .then((raw) => {
        const normalized = normalizeSchemas(raw);
        setSchemas(normalized);
        const first = Object.keys(normalized)[0];
        if (first) setProvider(first);
      })
      .catch(() => setSchemas({}))
      .finally(() => setLoading(false));
  }, []);

  const providers = useMemo(
    () => (Object.keys(schemas).length ? Object.keys(schemas) : fallbackProviders),
    [schemas],
  );
  const jsonSchema = getJsonSchema(schemas[provider]);
  const properties = jsonSchema.properties ?? {
    api_key: { title: "API Key", type: "string" },
    base_url: { title: "Base URL（可选）", type: "string" },
  };
  const required = jsonSchema.required ?? ["api_key"];
  const fields = Object.entries(properties).filter(
    ([key]) => !["type", "id", "created_at"].includes(key),
  );

  const setField = (key: string, value: string) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const changeProvider = (next: string) => {
    setProvider(next);
    setValues({});
  };

  const saveModel = async () => {
    const missing = fields
      .filter(([key]) => required.includes(key) && !values[key]?.trim())
      .map(([, field]) => field.title ?? "字段");
    if (!values.model?.trim()) missing.push("模型名称");
    if (missing.length) {
      toast.error(`请输入${missing.join("、")}`);
      return;
    }
    setSaving(true);
    try {
      const credentials = Object.fromEntries(
        fields
          .map(([key]) => [key, values[key]])
          .filter(([, value]) => value),
      );
      const response = await request<{ credential_id: string }>("/credential/", {
        method: "POST",
        body: JSON.stringify({ data: { ...credentials, type: provider } }),
      });
      const providerName = provider.replace("_credential", "");
      await onSaveModel({
        credential_id: response.credential_id,
        model_type:
          providerName === "openai" ? "openai_chat" : `${providerName}_chat`,
        model: String(values.model ?? ""),
      });
      toast.success("模型配置成功");
      setStep(1);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "凭据保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleTask = async (prompt: string) => {
    markOnboarded();
    onClose();
    await onSendTask(prompt);
  };

  const finish = () => {
    markOnboarded();
    onClose();
  };

  return (
    /* Full-screen overlay */
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-card p-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <StepDots current={step} total={2} />
          <button
            onClick={finish}
            className="text-xs text-ink-faint transition-colors hover:text-ink-muted"
          >
            跳过
          </button>
        </div>

        {/* ─── Step 1: Model config ─── */}
        {step === 0 && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                <KeyIcon className="size-5 text-foreground" />
              </div>
              <h2 className="text-xl font-bold tracking-title text-foreground">
                连接你的模型
              </h2>
              <p className="text-sm leading-relaxed text-ink-muted">
                智能体团队需要一个 LLM 后端。密钥只提交给本机服务，不会离开你的电脑。
              </p>
            </div>

            {loading ? (
              <div className="flex flex-col gap-3">
                <div className="h-9 animate-pulse rounded-md bg-muted" />
                <div className="h-9 animate-pulse rounded-md bg-muted" />
                <div className="h-9 animate-pulse rounded-md bg-muted" />
              </div>
            ) : (
              <form
                className="flex flex-col gap-4"
                autoComplete="off"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveModel();
                }}
              >
                <div className="flex flex-col gap-2">
                  <Label>模型提供商</Label>
                  <Select value={provider} onValueChange={changeProvider}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[101]">
                      {providers.map((item) => (
                        <SelectItem key={item} value={item}>
                          <span className="flex items-center gap-2">
                            <ProviderIcon provider={item} className="size-4 shrink-0 text-ink-muted" />
                            {providerName(item)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {fields.map(([key, field]) => (
                  <div key={key} className="flex flex-col gap-2">
                    <Label htmlFor={`ob-${key}`}>
                      {field.title ?? key}
                      {required.includes(key) ? (
                        <span className="text-destructive"> *</span>
                      ) : null}
                    </Label>
                    <Input
                      id={`ob-${key}`}
                      type={secretPattern.test(key) ? "password" : "text"}
                      value={values[key] ?? ""}
                      onChange={(e) => setField(key, e.target.value)}
                      autoComplete={
                        secretPattern.test(key) ? "new-password" : "off"
                      }
                    />
                  </div>
                ))}

                <div className="flex flex-col gap-2">
                  <Label htmlFor="ob-model">
                    模型名称<span className="text-destructive"> *</span>
                  </Label>
                  <Input
                    id="ob-model"
                    value={values.model ?? ""}
                    onChange={(e) => setField("model", e.target.value)}
                    placeholder="例如：qwen-plus / gpt-4.1-mini"
                  />
                </div>

                <Button
                  type="submit"
                  disabled={saving}
                  className="w-full rounded-full"
                >
                  {saving ? "保存中…" : "保存并继续"}
                  {!saving && <ArrowRightIcon className="ml-1 size-4" />}
                </Button>
              </form>
            )}
          </div>
        )}

        {/* ─── Step 2: Example tasks ─── */}
        {step === 1 && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                <RocketIcon className="size-5 text-foreground" />
              </div>
              <h2 className="text-xl font-bold tracking-title text-foreground">
                试试看
              </h2>
              <p className="text-sm leading-relaxed text-ink-muted">
                模型已就绪。选择一个任务开始体验，或关闭后自由输入。
              </p>
            </div>

            <div className="flex flex-col gap-3">
              {EXAMPLE_TASKS.map((task) => (
                <button
                  key={task.label}
                  onClick={() => void handleTask(task.prompt)}
                  className="group flex items-center gap-3 rounded-xl bg-muted px-4 py-3 text-left transition-all hover:bg-accent"
                >
                  <span className="text-lg">{task.icon}</span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-medium text-foreground">
                      {task.label}
                    </span>
                    <span className="truncate text-xs text-ink-faint">
                      {task.prompt}
                    </span>
                  </div>
                  <SparklesIcon className="size-4 shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>

            <Button
              variant="outline"
              onClick={finish}
              className="w-full rounded-full"
            >
              <CheckIcon className="mr-1 size-4" />
              完成，自由探索
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
