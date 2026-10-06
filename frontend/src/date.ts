const zone = "Asia/Shanghai";
const partFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: zone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function dateParts(value: string) {
  const parts = partFormatter.formatToParts(new Date(value));
  const find = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return { year: find("year"), month: find("month"), day: find("day") };
}

export function formatDate(value: string, includeYear = true) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone,
    ...(includeYear ? { year: "numeric" as const } : {}),
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(value));
}

export function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

// datetime-local represents the entered wall clock time; always interpret it as Beijing time.
export function beijingInputToIso(value: string) {
  const date = new Date(`${value}:00+08:00`);
  if (!Number.isFinite(date.getTime()))
    throw new Error("请输入有效的活动开始时间。");
  return date.toISOString();
}

export function beijingInputMin() {
  const date = new Date(Date.now() + 60_000);
  const parts = dateParts(date.toISOString());
  return `${parts.year}-${parts.month}-${parts.day}T${formatTime(date.toISOString())}`;
}
