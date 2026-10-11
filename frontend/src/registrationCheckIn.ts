import type { Activity, AdminRegistration } from "./types";

export function canCheckInRegistration(
  activity: Pick<Activity, "closed" | "cancelled">,
  registration: Pick<AdminRegistration, "status" | "checkedInAt">,
): boolean {
  return activity.closed && !activity.cancelled && registration.status === "ACTIVE" && !registration.checkedInAt;
}

export function checkInLabel(registration: Pick<AdminRegistration, "status" | "checkedInAt">): string {
  if (registration.status !== "ACTIVE") return "不适用";
  return registration.checkedInAt ? "已签到" : "未签到";
}
