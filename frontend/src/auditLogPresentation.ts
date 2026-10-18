import { formatPreciseDateTime } from "./date.ts";
import type { AuditLogAction, AuditLogField } from "./types";
import { activityCategoryLabel, isActivityCategory } from "./activityCategory.ts";

export const auditActionLabels: Record<AuditLogAction, string> = {
  CREATE: "发布活动", EDIT: "编辑活动", CANCEL: "取消活动", CHECK_IN: "管理员签到",
};

export const auditFieldLabels: Record<AuditLogField, string> = {
  title: "活动标题", description: "活动介绍", location: "活动地点",
  category: "活动分类",
  coverHash: "活动封面内容编号",
  startsAt: "开始时间（北京时间）", capacity: "活动名额",
  cancelledAt: "取消时间（北京时间）", cancellationReason: "取消原因",
  checkedInAt: "签到时间（北京时间）",
};

export function formatAuditDateTime(value: string): string {
  return formatPreciseDateTime(value);
}

export function auditChangeText(field: AuditLogField, value: string | null): string {
  if (value === null) return "未设置";
  if (field === "category" && isActivityCategory(value)) return activityCategoryLabel(value);
  return field === "startsAt" || field === "cancelledAt" || field === "checkedInAt"
    ? formatAuditDateTime(value) : value;
}
