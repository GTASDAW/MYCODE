import { Button } from "antd";
import { locationCheckInUnavailableReason } from "../registrationCheckIn";
import type { MyRegistration } from "../types";

export function LocationCheckInButton({ registration, enabled, now, busy, locating, error, onCheckIn }: {
  registration: MyRegistration;
  enabled: boolean;
  now: number;
  busy: number | null;
  locating: boolean;
  error?: string | null;
  onCheckIn: () => void;
}) {
  const eligible = registration.status === "ACTIVE" && !registration.checkedInAt && !registration.activity.cancelled;
  if (!eligible && !error) return null;
  const reason = locationCheckInUnavailableReason(registration, enabled, now);
  const pending = busy === registration.id;
  const errorId = `location-checkin-error-${registration.id}`;
  return <div className="location-checkin-action">
    {eligible && <><Button type="primary" aria-label={`到场签到 ${registration.id}`} aria-describedby={error ? errorId : undefined} loading={pending}
      disabled={busy !== null || reason !== null} onClick={onCheckIn}>
      {pending ? locating ? "正在定位" : "正在签到" : "到场签到"}
    </Button>
    <p className="metadata">{reason ?? (pending && locating
      ? "请在浏览器弹窗中允许定位；若已拒绝，可在网站信息/权限中修改。"
      : "到达场地附近 300 米内后点击，将请求本次定位。")}</p></>}
    {error && <p id={errorId} role="alert" className="location-checkin-error">{error}</p>}
  </div>;
}
