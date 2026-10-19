import type { Activity } from "./types";
import { instantMicroseconds } from "./date.ts";

type ActivityTime = Pick<Activity, "startsAt" | "endsAt" | "registrationDeadline" | "cancelled">;
export type ActivityPhase = "CANCELLED" | "UPCOMING" | "ONGOING" | "ENDED" | "STARTED";
export const activityPhaseLabels: Record<ActivityPhase, string> = {
  CANCELLED: "活动已取消", UPCOMING: "未开始", ONGOING: "进行中", ENDED: "已结束", STARTED: "已开始",
};

export function activityPhase(activity: ActivityTime, now = Date.now()): ActivityPhase {
  if (activity.cancelled) return "CANCELLED";
  const start = instantMicroseconds(activity.startsAt);
  const current = BigInt(Math.trunc(now)) * 1000n;
  if (start !== null && current < start) return "UPCOMING";
  const end = activity.endsAt ? instantMicroseconds(activity.endsAt) : null;
  if (start === null || end === null || end <= start) return "STARTED";
  return current < end ? "ONGOING" : "ENDED";
}

export function nextActivityBoundary(activities: readonly ActivityTime[], now: number): number | null {
  let next: number | null = null;
  for (const activity of activities) {
    if (activity.cancelled) continue;
    for (const value of [activity.startsAt, activity.endsAt, activity.registrationDeadline]) {
      const micros = value ? instantMicroseconds(value) : null;
      if (micros === null) continue;
      const deadline = Number((micros + 999n) / 1000n);
      if (deadline > now && (next === null || deadline < next)) next = deadline;
    }
  }
  return next;
}

export function activityClosed(activity: Activity, now = Date.now()): boolean {
  return activity.cancelled || activity.closed || activityPhase(activity, now) !== "UPCOMING";
}

export function activityRegistrationClosed(activity: Activity, now = Date.now()): boolean {
  if (activityClosed(activity, now) || activity.registrationClosed === true) return true;
  const deadline = activity.registrationDeadline ? instantMicroseconds(activity.registrationDeadline) : null;
  return deadline !== null && deadline <= BigInt(Math.trunc(now)) * 1000n;
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
