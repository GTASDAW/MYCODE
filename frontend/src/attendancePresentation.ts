export function attendanceRateText(value: number | null | undefined): string {
  if (value === null) return "不适用（无有效报名）";
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > 100) return "—";
  return `${value.toFixed(2)}%`;
}
