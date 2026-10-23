export const activityStartDateMin = "2000-01-01";
export const activityStartDateMax = "2100-12-31";
export const invalidActivityStartDateMessage = "请选择 2000-01-01 至 2100-12-31 之间的有效开始日期。";

export function isActivityStartDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < activityStartDateMin || value > activityStartDateMax)
    return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function activityStartDateRangeError(from: string, to: string): string | null {
  if (from !== "" && !isActivityStartDate(from) || to !== "" && !isActivityStartDate(to))
    return invalidActivityStartDateMessage;
  return from !== "" && to !== "" && from > to ? "开始日期（起）不能晚于开始日期（止）。" : null;
}
