import type { Activity, ActivityCategory, NewActivity } from "./types";
import { isActivityCategory } from "./activityCategory.ts";
import { beijingInputToIso } from "./date.ts";

export const ordinaryActivityCreatePath = "/admin/activities/new";
export type ActivityCopySource = { kind: "ordinary" } | { kind: "copy"; id: number } | { kind: "invalid" };

export function parseActivityCopySource(search: string): ActivityCopySource {
  const values = new URLSearchParams(search).getAll("copyFrom");
  if (values.length === 0) return { kind: "ordinary" };
  if (values.length !== 1 || !/^\d+$/.test(values[0])) return { kind: "invalid" };
  const id = Number(values[0]);
  return Number.isSafeInteger(id) && id > 0 ? { kind: "copy", id } : { kind: "invalid" };
}

export function activityCopyPath(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("复制来源活动编号无效。");
  return `${ordinaryActivityCreatePath}?copyFrom=${id}`;
}

export async function readActivityCopySource(
  source: ActivityCopySource,
  read: (id: string, signal: AbortSignal) => Promise<Activity>,
  signal: AbortSignal,
): Promise<Activity | null> {
  signal.throwIfAborted();
  if (source.kind !== "copy") return null;
  const activity = await read(String(source.id), signal);
  signal.throwIfAborted();
  if (activity.id !== source.id) throw new Error("复制来源信息不匹配，请重新加载。");
  return activity;
}

export interface ActivityCreateFormValues {
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt?: string;
  capacity: number;
  category: ActivityCategory;
}

export function activityCopyDraft(activity: Activity): Partial<ActivityCreateFormValues> {
  return {
    title: activity.title,
    description: activity.description,
    location: activity.location,
    category: isActivityCategory(activity.category) ? activity.category : "UNCATEGORIZED",
    capacity: activity.capacity,
    startsAt: undefined,
    endsAt: undefined,
  };
}

export function activityCreateRequest(values: ActivityCreateFormValues): NewActivity {
  return {
    title: values.title.trim(),
    description: values.description.trim(),
    location: values.location.trim(),
    category: values.category,
    capacity: values.capacity,
    startsAt: beijingInputToIso(values.startsAt),
    endsAt: values.endsAt ? beijingInputToIso(values.endsAt) : null,
  };
}
