import type { ActivityCategory, ActivityCategoryFilter } from "./types";

export const activityCategoryLabels: Record<ActivityCategory, string> = {
  UNCATEGORIZED: "未分类",
  TECHNOLOGY: "技术交流",
  SPORTS: "运动户外",
  CULTURE: "文化艺术",
  OTHER: "其他",
};

export const activityCategoryOptions = Object.entries(activityCategoryLabels)
  .map(([value, label]) => ({ value: value as ActivityCategory, label }));

export const activityCategoryFilterOptions = [
  { value: "ALL" as const, label: "全部分类" }, ...activityCategoryOptions,
];

export function isActivityCategory(value: unknown): value is ActivityCategory {
  return typeof value === "string" && Object.hasOwn(activityCategoryLabels, value);
}

export function activityCategoryLabel(value: unknown): string {
  return isActivityCategory(value) ? activityCategoryLabels[value] : "未分类";
}

export function parseActivityCategoryFilter(value: unknown): ActivityCategoryFilter {
  return isActivityCategory(value) ? value : "ALL";
}
