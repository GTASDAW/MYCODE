import type { Activity } from "./types";

export function activityClosed(activity: Activity, now = Date.now()): boolean {
  return activity.cancelled || activity.closed || Date.parse(activity.startsAt) <= now;
}

export function canManageActivity(activity: Activity, now = Date.now()): boolean {
  return !activityClosed(activity, now);
}

export function cancellationReasonError(value: string): string | null {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value))
    return "取消原因需为单行文字，不包含控制字符。";
  const length = value.trim().length;
  if (!length) return "请填写取消原因";
  if (length > 500) return "取消原因最多 500 个字符";
  return null;
}
