import { dateParts } from "./date.ts";
import type { AttendanceQuery } from "./types";

const dayMilliseconds = 86_400_000;

export function isAttendanceDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function attendanceRangeError(from: string, to: string): string | null {
  if (!isAttendanceDate(from) || !isAttendanceDate(to))
    return "请选择 2000 年至 2100 年之间的有效开始和结束日期。";
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMilliseconds + 1;
  if (days < 1) return "开始日期不能晚于结束日期。";
  if (days > 366) return "日期范围最多包含 366 天，请缩小范围。";
  return null;
}

export function defaultAttendanceQuery(now = Date.now()): AttendanceQuery {
  const today = dateParts(new Date(now).toISOString());
  const to = `${today.year}-${today.month}-${today.day}`;
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 29 * dayMilliseconds).toISOString().slice(0, 10);
  return { from, to, page: 1, pageSize: 10 };
}

function positiveInteger(value: string | null, fallback: number, maximum: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? number : fallback;
}

export function parseAttendanceQuery(search: string, defaults = defaultAttendanceQuery()): AttendanceQuery {
  const params = new URLSearchParams(search);
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const validRange = !attendanceRangeError(from, to);
  return {
    from: validRange ? from : defaults.from,
    to: validRange ? to : defaults.to,
    page: positiveInteger(params.get("page"), 1, 2_147_483_647),
    pageSize: positiveInteger(params.get("pageSize"), 10, 100),
  };
}

export function serializeAttendanceQuery(query: AttendanceQuery): string {
  const params = new URLSearchParams({ from: query.from, to: query.to });
  if (query.page !== 1) params.set("page", String(query.page));
  if (query.pageSize !== 10) params.set("pageSize", String(query.pageSize));
  return `?${params}`;
}

export function attendanceDashboardPath(query: AttendanceQuery): string {
  return `/admin/dashboard${serializeAttendanceQuery(query)}`;
}
