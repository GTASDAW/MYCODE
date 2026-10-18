import type { Activity, AdminRegistration } from "./types";
import { instantMicroseconds } from "./date.ts";

export function canCheckInRegistration(
  activity: Pick<Activity, "closed" | "cancelled"> & Partial<Pick<Activity, "startsAt" | "endsAt">>,
  registration: Pick<AdminRegistration, "status" | "checkedInAt">,
  now = Date.now(),
): boolean {
  const start = activity.startsAt ? instantMicroseconds(activity.startsAt) : null;
  const started = activity.closed || start !== null && start <= BigInt(Math.trunc(now)) * 1000n;
  return started && !activity.cancelled && registration.status === "ACTIVE" && !registration.checkedInAt;
}

export function checkInLabel(registration: Pick<AdminRegistration, "status" | "checkedInAt">): string {
  if (registration.status !== "ACTIVE") return "不适用";
  return registration.checkedInAt ? "已签到" : "未签到";
}
