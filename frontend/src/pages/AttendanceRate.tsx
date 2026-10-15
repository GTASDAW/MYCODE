import { Progress } from "antd";
import { attendanceRateText } from "../attendancePresentation";

export function AttendanceRate({ value, testId }: { value: number | null | undefined; testId?: string }) {
  const valid = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  return <div className="attendance-rate">
    <span data-testid={testId}>{attendanceRateText(value)}</span>
    {valid && <Progress percent={value} showInfo={false} size="small" aria-label="当前签到比例" />}
  </div>;
}
