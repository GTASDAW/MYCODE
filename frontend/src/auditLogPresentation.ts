import { formatPreciseDateTime } from "./date.ts";
import type { AuditLogAction, AuditLogField } from "./types";
import { activityCategoryLabel, isActivityCategory } from "./activityCategory.ts";
import { checkInMethodLabel } from "./registrationCheckIn.ts";

export const auditActionLabels: Record<AuditLogAction, string> = {
  CREATE: "发布活动", EDIT: "编辑活动", CANCEL: "取消活动", CHECK_IN: "签到", CHECK_IN_REVOKE: "撤销签到",
};

export const auditFieldLabels: Record<AuditLogField, string> = {
  title: "活动标题", description: "活动介绍", location: "活动地点",
  locationLongitude: "地图经度（GCJ-02）", locationLatitude: "地图纬度（GCJ-02）",
  category: "活动分类",
  coverHash: "活动封面内容编号",
  startsAt: "开始时间（北京时间）", endsAt: "结束时间（北京时间）",
  registrationDeadline: "报名截止时间（北京时间）", capacity: "活动名额",
  cancelledAt: "取消时间（北京时间）", cancellationReason: "取消原因",
  checkedInAt: "签到时间（北京时间）",
  checkInMethod: "签到方式", checkedInBy: "签到管理员 ID", checkInReason: "签到更正原因",
};

export function formatAuditDateTime(value: string): string {
  return formatPreciseDateTime(value);
}

export function auditChangeText(field: AuditLogField, value: string | null): string {
  if (value === null) return "未设置";
  if (field === "category" && isActivityCategory(value)) return activityCategoryLabel(value);
  if (field === "checkInMethod" && (value === "ADMIN" || value === "SELF_LOCATION")) return checkInMethodLabel(value);
  return field === "startsAt" || field === "endsAt" || field === "registrationDeadline" || field === "cancelledAt" || field === "checkedInAt"
    ? formatAuditDateTime(value) : value;
}
