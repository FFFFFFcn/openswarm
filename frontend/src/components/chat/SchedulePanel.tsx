import { useCallback, useEffect, useState } from "react";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { scheduleApi, type ScheduleRecord } from "@/api/client";
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
import { Textarea } from "@/components/ui/textarea";

const CUSTOM_CRON = "__custom__";

const cronPresets = [
  { label: "每天 09:00", value: "0 9 * * *" },
  { label: "每天 18:00", value: "0 18 * * *" },
  { label: "每周一 09:00", value: "0 9 * * 1" },
  { label: "每小时整点", value: "0 * * * *" },
  { label: "自定义 cron", value: CUSTOM_CRON },
];

/**
 * Scheduled-task dialog: create a cron-triggered agent run (name + task
 * prompt + schedule) and manage the existing schedules. The target agent and
 * model config come from the current conversation via `getContext`.
 */
export function SchedulePanel({
  open,
  onOpenChange,
  getContext,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  getContext: () => Promise<{ agentId: string; chatModelConfig: Record<string, unknown> }>;
}) {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [preset, setPreset] = useState(cronPresets[0]?.value ?? CUSTOM_CRON);
  const [customCron, setCustomCron] = useState("");
  const [busy, setBusy] = useState(false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";

  const refresh = useCallback(() => {
    scheduleApi
      .list()
      .then(setSchedules)
      .catch(() => setSchedules([]));
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const cron = preset === CUSTOM_CRON ? customCron.trim() : preset;

  const create = async () => {
    if (!name.trim() || !description.trim() || !cron) return;
    setBusy(true);
    try {
      const context = await getContext();
      await scheduleApi.create({
        name: name.trim(),
        description: description.trim(),
        cron_expression: cron,
        timezone,
        agent_id: context.agentId,
        chat_model_config: context.chatModelConfig,
      });
      toast.success("定时任务已创建");
      setName("");
      setDescription("");
      refresh();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "创建定时任务失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await scheduleApi.remove(id);
      setSchedules((prev) => prev.filter((entry) => entry.id !== id));
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "删除失败");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>定时任务</DialogTitle>
          <DialogDescription>
            按计划自动触发团队执行任务，时区：{timezone}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-name">任务名称</Label>
            <Input
              id="schedule-name"
              value={name}
              maxLength={60}
              placeholder="例如：每日爆款监控"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-desc">任务内容</Label>
            <Textarea
              id="schedule-desc"
              value={description}
              placeholder="到点后要执行的具体任务，例如：分析 AI 工具赛道近 24 小时的爆款笔记并生成报告"
              className="min-h-[72px]"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-cron">执行时间</Label>
            <select
              id="schedule-cron"
              value={preset}
              onChange={(event) => setPreset(event.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none"
            >
              {cronPresets.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {preset === CUSTOM_CRON ? (
              <Input
                value={customCron}
                placeholder="cron 表达式（分 时 日 月 周），例如 30 8 * * 1-5"
                onChange={(event) => setCustomCron(event.target.value)}
              />
            ) : null}
          </div>
        </div>

        {schedules.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-ink-muted">已有任务</p>
            <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {schedules.map((schedule) => (
                <li
                  key={schedule.id}
                  className="flex items-center justify-between gap-2 rounded-md bg-muted px-2.5 py-1.5 text-[13px]"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium text-foreground">{schedule.name}</span>
                    <span className="ml-2 text-ink-muted">{schedule.cron_expression}</span>
                  </span>
                  <button
                    type="button"
                    aria-label="删除定时任务"
                    onClick={() => void remove(schedule.id)}
                    className="rounded p-1 text-ink-muted transition-colors hover:bg-card hover:text-red-500"
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button
            disabled={busy || !name.trim() || !description.trim() || !cron}
            onClick={() => void create()}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            创建定时任务
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
