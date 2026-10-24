import { Button } from "antd";
import { locationCheckInUnavailableReason } from "../registrationCheckIn";
import type { MyRegistration } from "../types";

export function LocationCheckInButton({ registration, enabled, now, busy, locating, onCheckIn }: {
  registration: MyRegistration;
  enabled: boolean;
  now: number;
  busy: number | null;
  locating: boolean;
  onCheckIn: () => void;
}) {
  if (registration.status !== "ACTIVE" || registration.checkedInAt || registration.activity.cancelled) return null;
  const reason = locationCheckInUnavailableReason(registration, enabled, now);
  const pending = busy === registration.id;
  return <div className="location-checkin-action">
    <Button type="primary" aria-label={`到场签到 ${registration.id}`} loading={pending}
      disabled={busy !== null || reason !== null} onClick={onCheckIn}>
      {pending ? locating ? "正在定位" : "正在签到" : "到场签到"}
    </Button>
    <p className="metadata">{reason ?? "到达场地附近 300 米内后点击，将请求本次定位。"}</p>
  </div>;
}
