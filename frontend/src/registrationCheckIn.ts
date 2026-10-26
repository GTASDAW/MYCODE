import type { Activity, AdminRegistration, MyRegistration, CheckInMethod, LocationCoordinateMode } from "./types";
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

export function checkInMethodLabel(method: CheckInMethod): string {
  return method === "SELF_LOCATION" ? "本人定位" : method === "ADMIN" ? "管理员确认" : "—";
}

export function canCorrectCheckInRegistration(
  activity: Parameters<typeof canCheckInRegistration>[0],
  registration: Pick<AdminRegistration, "status" | "checkedInAt">,
  now = Date.now(),
): boolean {
  return canCheckInRegistration(activity, { ...registration, checkedInAt: null }, now);
}

export const gcj02UnavailableMessage = "当前服务暂不支持高德坐标兼容签到，请刷新页面后重试；不会自动切换标准定位。";

export function locationCoordinateModeUnavailableReason(mode: unknown, gcj02Supported: unknown): string | null {
  if (mode === "WGS84") return null;
  if (mode === "GCJ02") return gcj02Supported === true ? null : gcj02UnavailableMessage;
  return "定位坐标模式无效，请重新选择标准定位或高德坐标兼容。";
}

export function locationCheckInUnavailableReason(
  registration: Pick<MyRegistration, "activity" | "status" | "checkedInAt">,
  enabled: boolean,
  now = Date.now(),
  mode: LocationCoordinateMode = "WGS84",
  gcj02Supported = false,
): string | null {
  const { activity, status, checkedInAt } = registration;
  if (activity.cancelled || status !== "ACTIVE" || checkedInAt) return "当前记录不能到场签到。";
  const modeError = locationCoordinateModeUnavailableReason(mode, gcj02Supported);
  if (modeError) return modeError;
  if (!enabled) return "到场定位签到暂不可用，请联系管理员确认到场。";
  if (!activity.locationPoint || !activity.endsAt) return "本活动由管理员确认到场。";
  const start = instantMicroseconds(activity.startsAt);
  const end = instantMicroseconds(activity.endsAt);
  const instant = BigInt(Math.trunc(now)) * 1000n;
  if (start === null || end === null) return "活动时间不可用，请联系管理员确认到场。";
  if (instant < start) return "活动开始后可到场签到。";
  if (instant >= end) return "到场签到已结束，请联系管理员补签。";
  return null;
}

export function checkInCorrectionReasonError(reason: string): string | null {
  if (!reason.trim()) return "请填写更正原因。";
  if (/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(reason)) return "更正原因须为单行文字。";
  if (reason.length > 500) return "更正原因最多 500 个字符。";
  return null;
}
