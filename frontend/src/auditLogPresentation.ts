import { formatDate } from "./date.ts";
import type { AuditLogAction, AuditLogField } from "./types";

export const auditActionLabels: Record<AuditLogAction, string> = {
  CREATE: "发布活动", EDIT: "编辑活动", CANCEL: "取消活动", CHECK_IN: "管理员签到",
};

export const auditFieldLabels: Record<AuditLogField, string> = {
  title: "活动标题", description: "活动介绍", location: "活动地点",
  startsAt: "开始时间（北京时间）", capacity: "活动名额",
  cancelledAt: "取消时间（北京时间）", cancellationReason: "取消原因",
  checkedInAt: "签到时间（北京时间）",
};

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

export function formatAuditDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间不可用";
  // Date preserves milliseconds only. Keep the server's original six decimal
  // places so distinct operations within the same millisecond stay visible.
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "";
  return `${formatDate(value)} ${timeFormatter.format(date)}.${fraction.padEnd(6, "0").slice(0, 6)}`;
}

export function auditChangeText(field: AuditLogField, value: string | null): string {
  if (value === null) return "未设置";
  return field === "startsAt" || field === "cancelledAt" || field === "checkedInAt"
    ? formatAuditDateTime(value) : value;
}
