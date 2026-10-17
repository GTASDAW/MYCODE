import { readActivityListQuery, writeActivityListQuery } from "./activityListQuery.ts";
import type { AdminActivityQuery } from "./types";

export const defaultAdminActivityQuery: AdminActivityQuery = {
  page: 1, pageSize: 10, keyword: "", status: "ALL", category: "ALL",
};

export function parseAdminActivityQuery(search: string) {
  return readActivityListQuery(search, 10, true);
}

export function serializeAdminActivityQuery(query: AdminActivityQuery): string {
  return writeActivityListQuery(query, 10);
}

export function adminActivityListPath(query: AdminActivityQuery): string {
  return `/admin/activities${serializeAdminActivityQuery(query)}`;
}
