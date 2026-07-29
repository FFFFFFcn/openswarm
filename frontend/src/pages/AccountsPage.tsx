import { useCallback, useEffect, useRef, useState } from "react";
import {
  CameraIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { toast } from "sonner";
import { accountsApi } from "@/api/client";
import type { AccountProfile, AccountProfileInput, ModelConfig } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { readStored } from "@/utils/storage";

const MODEL_KEY = "openswarm-model";
/** Accepted screenshot formats (mirrors the backend extract endpoint). */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** ~10MB binary ceiling for a screenshot upload. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface FormState {
  account_name: string;
  niche: string;
  red_id: string;
  follower_count: string;
  notes_count: string;
  intro: string;
  profile_url: string;
  target_audience: string;
  primary_goal: string;
  voice: string;
  source: "manual" | "screenshot";
}

const EMPTY_FORM: FormState = {
  account_name: "",
  niche: "",
  red_id: "",
  follower_count: "",
  notes_count: "",
  intro: "",
  profile_url: "",
  target_audience: "",
  primary_goal: "",
  voice: "",
  source: "manual",
};

function formFromAccount(account: AccountProfile): FormState {
  return {
    account_name: account.account_name,
    niche: account.niche,
    red_id: account.red_id ?? "",
    follower_count: account.follower_count != null ? String(account.follower_count) : "",
    notes_count: account.notes_count != null ? String(account.notes_count) : "",
    intro: account.intro ?? "",
    profile_url: account.profile_url ?? "",
    target_audience: account.target_audience ?? "",
    primary_goal: account.primary_goal ?? "",
    voice: account.voice ?? "",
    source: account.source ?? "manual",
  };
}

function payloadFromForm(form: FormState): AccountProfileInput {
  const parseCount = (value: string): number | null => {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  return {
    account_name: form.account_name.trim(),
    niche: form.niche.trim(),
    red_id: form.red_id.trim(),
    follower_count: parseCount(form.follower_count),
    notes_count: parseCount(form.notes_count),
    intro: form.intro.trim(),
    profile_url: form.profile_url.trim(),
    target_audience: form.target_audience.trim(),
    primary_goal: form.primary_goal.trim(),
    voice: form.voice.trim(),
    source: form.source,
  };
}

function formatCount(value: number | null): string {
  if (value == null) return "—";
  if (value >= 10_000) {
    const wan = value / 10_000;
    return `${wan >= 100 ? Math.round(wan) : Math.round(wan * 10) / 10}万`;
  }
  return String(value);
}

/**
 * Account library page: card list of every Xiaohongshu account plus two
 * entry points — screenshot extraction (vision model fills the form) and a
 * plain manual form. Deleting an account cascades to its strategies /
 * topics / drafts, so the delete button uses a two-step confirm.
 */
export function AccountsPage() {
  const [accounts, setAccounts] = useState<AccountProfile[]>([]);
  const [loading, setLoading] = useState(true);
  // Form dialog state: null = closed, "new" = creating, otherwise editing id.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAccounts(await accountsApi.list());
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "加载账号库失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openManual = () => {
    setForm(EMPTY_FORM);
    setEditing("new");
  };

  const openEdit = (account: AccountProfile) => {
    setForm(formFromAccount(account));
    setEditing(account.id);
  };

  /** Screenshot flow: pick a file → extract → open the pre-filled form. */
  const handleScreenshot = async (file: File) => {
    if (!IMAGE_TYPES.has(file.type)) {
      toast.error("仅支持 PNG / JPEG / WebP 格式的截图");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error("截图过大（超过 10MB），请压缩后重试");
      return;
    }
    const model = readStored<ModelConfig>(MODEL_KEY);
    if (!model?.credential_id || !model.model) {
      toast.error("请先在“设置”中保存模型凭据，再使用截图识别");
      return;
    }
    setExtracting(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(file);
      });
      const result = await accountsApi.extract({
        image_base64: base64,
        mime_type: file.type,
        model: model.model,
        credential_id: model.credential_id,
      });
      setForm({
        ...EMPTY_FORM,
        account_name: result.account_name ?? "",
        niche: result.niche ?? "",
        red_id: result.red_id ?? "",
        follower_count: result.follower_count != null ? String(result.follower_count) : "",
        notes_count: result.notes_count != null ? String(result.notes_count) : "",
        intro: result.intro ?? "",
        source: "screenshot",
      });
      setEditing("new");
      toast.success("识别完成，请核对后保存");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "截图识别失败，请改用手动录入");
    } finally {
      setExtracting(false);
    }
  };

  const handleSave = async () => {
    const payload = payloadFromForm(form);
    if (!payload.account_name) {
      toast.error("请填写账号名");
      return;
    }
    if (!payload.niche) {
      toast.error("请填写账号赛道");
      return;
    }
    setSaving(true);
    try {
      if (editing === "new") {
        await accountsApi.create(payload);
        toast.success("账号已录入");
      } else if (editing) {
        await accountsApi.update(editing, payload);
        toast.success("账号已更新");
      }
      setEditing(null);
      await refresh();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  /** Two-step delete: first click arms the confirm, second click executes. */
  const handleDelete = async (id: string) => {
    if (confirmingId !== id) {
      setConfirmingId(id);
      return;
    }
    setDeletingId(id);
    try {
      await accountsApi.remove(id);
      toast.success("账号已删除（关联的策略 / 选题 / 草稿一并清除）");
      await refresh();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  };

  const setField = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">账号库</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            管理你的小红书账号，策略、选题与草稿都会归属到对应账号
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void handleScreenshot(file);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={extracting}
            onClick={() => fileInputRef.current?.click()}
          >
            {extracting ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <CameraIcon className="size-4" />
            )}
            {extracting ? "识别中…" : "截图录入"}
          </Button>
          <Button size="sm" onClick={openManual}>
            <PlusIcon className="size-4" />
            手动录入
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 pb-6">
          {loading ? (
            <p className="py-10 text-center text-sm text-ink-muted">正在加载…</p>
          ) : accounts.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <UsersIcon className="size-10 text-ink-faint" />
              <p className="text-sm text-ink-muted">账号库还是空的</p>
              <p className="text-xs text-ink-faint">
                上传小红书主页截图自动识别，或手动填写账号信息
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {accounts.map((account) => (
                <div
                  key={account.id}
                  className="group flex flex-col gap-2 rounded-lg bg-card p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {account.account_name}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-ink-muted">
                        {account.red_id ? `小红书号：${account.red_id}` : "小红书号未填写"}
                      </p>
                    </div>
                    <Badge variant="secondary" className="shrink-0 text-[11px]">
                      {account.source === "screenshot" ? "截图识别" : "手动录入"}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-secondary">
                    <span>赛道：{account.niche}</span>
                    <span>粉丝 {formatCount(account.follower_count)}</span>
                    <span>笔记 {formatCount(account.notes_count)}</span>
                  </div>
                  {account.intro && (
                    <p className="line-clamp-2 text-xs text-ink-muted">{account.intro}</p>
                  )}
                  <div className="mt-1 flex items-center justify-end gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => openEdit(account)}
                    >
                      <PencilIcon className="size-3.5" />
                      编辑
                    </Button>
                    <Button
                      variant={confirmingId === account.id ? "destructive" : "ghost"}
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={deletingId === account.id}
                      onClick={() => void handleDelete(account.id)}
                      onBlur={() => setConfirmingId((prev) => (prev === account.id ? null : prev))}
                    >
                      <Trash2Icon className="size-3.5" />
                      {deletingId === account.id
                        ? "删除中…"
                        : confirmingId === account.id
                          ? "确认删除？将清除其策略/选题/草稿"
                          : "删除"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editing === "new"
                ? form.source === "screenshot"
                  ? "确认识别结果"
                  : "手动录入账号"
                : "编辑账号"}
            </DialogTitle>
            <DialogDescription>
              {form.source === "screenshot" && editing === "new"
                ? "以下信息由截图自动识别，请核对并补全后保存"
                : "账号名与赛道为必填，其余可稍后补充"}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-name">账号名 *</Label>
              <Input
                id="acc-name"
                value={form.account_name}
                onChange={(e) => setField("account_name")(e.target.value)}
                placeholder="例如：阿粒的成长笔记"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-niche">账号赛道 *</Label>
              <Input
                id="acc-niche"
                value={form.niche}
                onChange={(e) => setField("niche")(e.target.value)}
                placeholder="例如：职场成长 / 母婴 / 美食"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-redid">小红书号</Label>
              <Input
                id="acc-redid"
                value={form.red_id}
                onChange={(e) => setField("red_id")(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-url">主页链接（备注）</Label>
              <Input
                id="acc-url"
                value={form.profile_url}
                onChange={(e) => setField("profile_url")(e.target.value)}
                placeholder="https://www.xiaohongshu.com/user/…"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-followers">粉丝数</Label>
              <Input
                id="acc-followers"
                inputMode="numeric"
                value={form.follower_count}
                onChange={(e) => setField("follower_count")(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-notes">笔记数</Label>
              <Input
                id="acc-notes"
                inputMode="numeric"
                value={form.notes_count}
                onChange={(e) => setField("notes_count")(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="acc-intro">主页简介</Label>
              <Textarea
                id="acc-intro"
                rows={2}
                value={form.intro}
                onChange={(e) => setField("intro")(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-audience">目标人群</Label>
              <Input
                id="acc-audience"
                value={form.target_audience}
                onChange={(e) => setField("target_audience")(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-goal">运营目标</Label>
              <Input
                id="acc-goal"
                value={form.primary_goal}
                onChange={(e) => setField("primary_goal")(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="acc-voice">内容风格</Label>
              <Input
                id="acc-voice"
                value={form.voice}
                onChange={(e) => setField("voice")(e.target.value)}
                placeholder="例如：亲切口语化，善用第一人称分享"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              取消
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
