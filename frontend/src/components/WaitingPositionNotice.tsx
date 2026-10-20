import type { Activity, Registration } from "../types";
import { waitingLifecycleText, waitingPositionText } from "../waitingPosition";

export function WaitingPositionNotice({
  activity,
  status = activity.registrationStatus,
  now,
  testId = "waiting-position",
}: {
  activity: Activity;
  status?: Registration["status"] | Activity["registrationStatus"];
  now?: number;
  testId?: string;
}) {
  if (activity.cancelled || status !== "WAITING") return null;
  const lifecycle = waitingLifecycleText(activity, status, now);
  return (
    <div className="waiting-position-notice" data-testid={testId}>
      <p className="remaining-text">{waitingPositionText(activity.waitingPosition)}</p>
      {lifecycle && <p className="remaining-text">{lifecycle}</p>}
    </div>
  );
}
