import { useEffect, useMemo, useState } from "react";
import { KeyIcon, ShieldCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { request } from "@/api/client";
import type { CredentialSchema, JsonSchema, ModelConfig } from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

const fallback = [
  "openai_credential",
  "dashscope_credential",
  "deepseek_credential",
  "anthropic_credential",
  "gemini_credential",
  "moonshot_credential",
  "ollama_credential",
  "xai_credential",
];
const secretPattern = /key|token|secret|password/i;

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

const securityRows: Array<[string, string]> = [
  ["监听范围", "默认 127.0.0.1"],
  ["业务数据", "本地 SQLite"],
  ["Agent 会话", "默认内嵌临时 Redis"],
  ["小红书发布", "不接入，仅人工发布"],
];

export function SettingsPage({
  model,
  onSave,
}: {
  model: ModelConfig | null;
  onSave: (value: ModelConfig) => Promise<void>;
}) {
  const [schemas, setSchemas] = useState<Record<string, CredentialSchema>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [provider, setProvider] = useState("openai_credential");
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    void request<unknown>("/credential/schemas")
      .then((value) => {
        const normalized = normalizeSchemas(value);
        setSchemas(normalized);
        const first = Object.keys(normalized)[0];
        if (first) setProvider(first);
      })
      .catch(() => setSchemas({}))
      .finally(() => setLoading(false));
  }, []);

  const providers = useMemo(
    () => (Object.keys(schemas).length ? Object.keys(schemas) : fallback),
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

  const save = async () => {
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
      await onSave({
        credential_id: response.credential_id,
        model_type:
          providerName === "openai" ? "openai_chat" : `${providerName}_chat`,
        model: String(values.model ?? ""),
      });
      setValues({});
      toast.success("模型已启用，下次任务会创建新的团队会话");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "凭据保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 lg:px-8">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            MODEL ACCESS
          </span>
          <h1 className="text-2xl font-bold tracking-h2 text-foreground">
            模型设置
          </h1>
          <p className="text-sm text-ink-muted">
            密钥只提交给本机凭据服务；浏览器仅保存凭据 ID、模型类型和模型名。
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyIcon className="size-4 text-ink-muted" />
                连接模型
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : (
                <form
                  className="flex flex-col gap-4"
                  autoComplete="off"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <div className="flex flex-col gap-2">
                    <Label>模型提供商</Label>
                    <Select value={provider} onValueChange={changeProvider}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {providers.map((item) => (
                          <SelectItem key={item} value={item}>
                            {item.replace("_credential", "").toUpperCase()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {fields.map(([key, field]) => (
                    <div key={key} className="flex flex-col gap-2">
                      <Label htmlFor={`field-${key}`}>
                        {field.title ?? key}
                        {required.includes(key) ? (
                          <span className="text-destructive"> *</span>
                        ) : null}
                      </Label>
                      <Input
                        id={`field-${key}`}
                        type={secretPattern.test(key) ? "password" : "text"}
                        value={values[key] ?? ""}
                        onChange={(event) => setField(key, event.target.value)}
                        autoComplete={
                          secretPattern.test(key) ? "new-password" : "off"
                        }
                      />
                      {field.description ? (
                        <p className="text-xs text-ink-faint">
                          {field.description}
                        </p>
                      ) : null}
                    </div>
                  ))}

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="field-model">
                      模型名称<span className="text-destructive"> *</span>
                    </Label>
                    <Input
                      id="field-model"
                      value={values.model ?? ""}
                      onChange={(event) => setField("model", event.target.value)}
                      placeholder="例如：qwen-plus / gpt-4.1-mini"
                    />
                  </div>

                  <Button type="submit" className="w-full" disabled={saving}>
                    {saving ? "保存中…" : "保存并启用"}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheckIcon className="size-4 text-ink-muted" />
                  安全边界
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <Alert>
                  <AlertTitle>V1 是本地单人工作台</AlertTitle>
                  <AlertDescription>
                    执行任务时，必要的账号与内容数据会发送给你选择的模型提供商。部署到公网前必须补充身份认证与持久 Redis。
                  </AlertDescription>
                </Alert>
                <div className="flex flex-col">
                  {securityRows.map(([label, value], index) => (
                    <div key={label}>
                      {index > 0 ? <Separator className="my-2" /> : null}
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-ink-muted">{label}</span>
                        <span className="text-foreground">{value}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">当前配置</CardTitle>
                <CardDescription>浏览器本地保存的模型凭据引用</CardDescription>
              </CardHeader>
              <CardContent>
                {model ? (
                  <div className="flex flex-col">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-ink-muted">模型类型</span>
                      <span className="text-foreground">{model.model_type}</span>
                    </div>
                    <Separator className="my-2" />
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-ink-muted">模型名称</span>
                      <span className="text-foreground">{model.model}</span>
                    </div>
                    <Separator className="my-2" />
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-ink-muted">凭据 ID</span>
                      <span className="font-mono text-foreground">
                        {model.credential_id.slice(0, 12)}…
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-ink-muted">尚未配置模型</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
