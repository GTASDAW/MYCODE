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

const preciseTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

export function formatPreciseDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间不可用";
  // Date keeps milliseconds only; retain the original UTC microseconds.
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "";
  return `${formatDate(value)} ${preciseTimeFormatter.format(date)}.${fraction.padEnd(6, "0").slice(0, 6)}`;
}

// datetime-local represents the entered wall clock time; always interpret it as Beijing time.
export function beijingInputToIso(value: string) {
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(value);
  if (!parts) throw new Error("请输入有效的活动时间。");
  const local = `${parts[1]}T${parts[2]}:${parts[3] ?? "00"}`;
  const date = new Date(`${local}+08:00`);
  if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 19) !== local)
    throw new Error("请输入有效的活动时间。");
  // MySQL stores microseconds; compare and submit the same truncated precision.
  const fraction = (parts[4] ?? "").slice(0, 6).padEnd(3, "0");
  return `${date.toISOString().slice(0, 19)}.${fraction}Z`;
}

export function instantMicroseconds(value: string): bigint | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "";
  return BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3, 6));
}

export function activityEndInputError(startsAt: string | undefined, endsAt: string | undefined): string | null {
  if (!endsAt) return null;
  try {
    const end = instantMicroseconds(beijingInputToIso(endsAt))!;
    if (!startsAt) return "请先选择开始时间";
    const start = instantMicroseconds(beijingInputToIso(startsAt))!;
    return end > start ? null : "结束时间必须晚于开始时间";
  } catch {
    return "请输入有效的活动时间";
  }
}

export function formatActivityEnd(value: string | null | undefined): string {
  return value ? `${formatDate(value)} ${formatTime(value)}` : "未提供";
}

export function beijingInputMin() {
  const date = new Date(Date.now() + 60_000);
  const parts = dateParts(date.toISOString());
  return `${parts.year}-${parts.month}-${parts.day}T${formatTime(date.toISOString())}`;
}
