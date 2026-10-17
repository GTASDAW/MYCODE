import type { ActivitySearchQuery } from "./types";
import { readActivityListQuery, writeActivityListQuery } from "./activityListQuery.ts";

export const defaultActivityQuery: ActivitySearchQuery = {
  keyword: "",
  status: "ALL",
  category: "ALL",
  page: 1,
  pageSize: 12,
};

export function parseActivityQuery(search: string): {
  query: ActivitySearchQuery;
  notice: string | null;
} {
  return readActivityListQuery(search, 12);
}

export function serializeActivityQuery(query: ActivitySearchQuery): string {
  return writeActivityListQuery(query, 12);
}

export function activityListPath(query: ActivitySearchQuery): string {
  return `/activities${serializeActivityQuery(query)}`;
}

export function safeActivityListPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\/activities(?:\?[^#]*)?$/.test(value) ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  ) return "/activities";
  const queryStart = value.indexOf("?");
  return activityListPath(parseActivityQuery(
    queryStart === -1 ? "" : value.slice(queryStart),
  ).query);
}

export function activityDetailsPath(id: number, from?: string): string {
  const path = `/activities/${id}`;
  if (from === undefined) return path;
  return `${path}?${new URLSearchParams({ from: safeActivityListPath(from) })}`;
}
