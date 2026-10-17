import type { Activity } from "./types";

export type CalendarActivity = Pick<Activity, "id" | "title" | "description" | "location" | "startsAt" | "cancelled">;
export const calendarContentType = "text/calendar;charset=utf-8";

function utcDate(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1000 || date.getUTCFullYear() > 9999)
    throw new Error("活动时间不正确，无法导出日历。");
  return date.toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
}

function text(value: string): string {
  if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value))
    throw new Error("活动内容包含不支持的字符，无法导出日历。");
  return value.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

// RFC 5545 folds physical lines at 75 octets, including the continuation space.
function fold(line: string): string {
  const encoder = new TextEncoder();
  let result = "", bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) { result += "\r\n "; bytes = 1; }
    result += character;
    bytes += size;
  }
  return result;
}

export function buildActivityCalendar(activity: CalendarActivity, origin: string, generatedAt: Date): string {
  if (activity.cancelled) throw new Error("活动已取消，无法导出日历。请刷新详情确认。");
  if (!Number.isSafeInteger(activity.id) || activity.id < 1) throw new Error("活动信息不正确，无法导出日历。");
  const site = new URL(origin);
  if (!["http:", "https:"].includes(site.protocol) || site.username || site.password)
    throw new Error("活动链接不正确，无法导出日历。");
  const canonical = new URL(`/activities/${activity.id}`, site.origin).href;
  const description = activity.description + "\n\n活动未提供结束时间，可在个人日历中自行设置；添加日历不代表报名成功。\n此文件为下载时快照，活动后续修改或取消不会自动同步。";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Gather//Activity Calendar//ZH-CN",
    "BEGIN:VEVENT", `UID:${canonical}`, `DTSTAMP:${utcDate(generatedAt)}`,
    `DTSTART:${utcDate(activity.startsAt)}`, `SUMMARY:${text(activity.title)}`,
    `DESCRIPTION:${text(description)}`, `LOCATION:${text(activity.location)}`, `URL:${canonical}`,
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
