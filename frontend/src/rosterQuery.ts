import type { AdminRegistrationQuery, CheckInFilter, RegistrationFilter } from "./types";

export const defaultRosterQuery: AdminRegistrationQuery = {
  page: 1, pageSize: 10, status: "ALL", checkInStatus: "ALL", keyword: "",
};
const statuses: RegistrationFilter[] = ["ALL", "ACTIVE", "WAITING", "CANCELLED"];
const checkInStatuses: CheckInFilter[] = ["ALL", "CHECKED_IN", "NOT_CHECKED_IN"];

function positiveInteger(value: string | null, fallback: number, maximum: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? number : fallback;
}

export function parseRosterQuery(search: string): { query: AdminRegistrationQuery; notice: string | null } {
  const params = new URLSearchParams(search);
  const keyword = params.get("keyword") ?? "";
  const status = params.get("status");
  const checkInStatus = params.get("checkInStatus");
  return {
    query: {
      keyword: keyword.length <= 200 ? keyword.trim() : "",
      status: statuses.includes(status as RegistrationFilter) ? status as RegistrationFilter : "ALL",
      checkInStatus: checkInStatuses.includes(checkInStatus as CheckInFilter) ? checkInStatus as CheckInFilter : "ALL",
      page: positiveInteger(params.get("page"), 1, 2_147_483_647),
      pageSize: positiveInteger(params.get("pageSize"), 10, 100),
    },
    notice: keyword.length > 200 ? "链接中的搜索关键词超过 200 个字符，已清空关键词；其他有效筛选条件保留。" : null,
  };
}

export function serializeRosterQuery(query: AdminRegistrationQuery): string {
  const params = new URLSearchParams();
  if (query.keyword !== "") params.set("keyword", query.keyword);
  if (query.status !== "ALL") params.set("status", query.status);
  if (query.checkInStatus !== "ALL") params.set("checkInStatus", query.checkInStatus);
  if (query.page !== 1) params.set("page", String(query.page));
  if (query.pageSize !== 10) params.set("pageSize", String(query.pageSize));
  return params.size ? `?${params}` : "";
}

export function rosterListPath(activityId: string | number, query: AdminRegistrationQuery): string {
  return `/admin/activities/${encodeURIComponent(String(activityId))}/registrations${serializeRosterQuery(query)}`;
}

export function rosterActivityDetailsPath(activityId: number, query: AdminRegistrationQuery): string {
  return `/activities/${activityId}?${new URLSearchParams({ from: rosterListPath(activityId, query) })}`;
}
