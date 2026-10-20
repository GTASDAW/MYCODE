import { activityClosed, activityRegistrationClosed } from "./activityLifecycle.ts";
import type { Activity, Registration } from "./types";

/** The API field is deliberately treated as untrusted JSON at the UI boundary. */
export function validWaitingPosition(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function waitingPositionText(value: unknown): string {
  const position = validWaitingPosition(value);
  return position === null
    ? "候补顺位暂不可用"
    : `候补第 ${position} 位，前面还有 ${position - 1} 人`;
}

type WaitingActivity = Pick<Activity, "cancelled" | "startsAt" | "endsAt" | "registrationDeadline" | "registrationClosed" | "closed">;

/**
 * Returns the lifecycle note for a person's current WAITING record.
 * Cancellation is checked first, and local time only changes this explanatory note.
 */
export function waitingLifecycleText(
  activity: WaitingActivity,
  status: Registration["status"] | Activity["registrationStatus"],
  now = Date.now(),
): string | null {
  if (activity.cancelled || status !== "WAITING") return null;
  if (activityClosed(activity as Activity, now)) return "活动已开始，候补递补已停止";
  if (activityRegistrationClosed(activity as Activity, now)) return "报名已截止，已有候补仍可在活动开始前递补";
  return null;
}
