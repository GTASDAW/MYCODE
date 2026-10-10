import type { NotificationFilter, NotificationQuery } from "./types";

export const defaultNotificationQuery: NotificationQuery = { page: 1, pageSize: 10, status: "ALL" };

function positiveInteger(value: string | null, fallback: number, maximum: number) {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? number : fallback;
}

export function parseNotificationQuery(search: string): NotificationQuery {
  const params = new URLSearchParams(search);
  const status = params.get("status");
  return {
    page: positiveInteger(params.get("page"), 1, 2_147_483_647),
    pageSize: positiveInteger(params.get("pageSize"), 10, 100),
    status: ["ALL", "UNREAD", "READ"].includes(status ?? "") ? status as NotificationFilter : "ALL",
  };
}

export function serializeNotificationQuery(query: NotificationQuery): string {
  const params = new URLSearchParams();
  if (query.status !== "ALL") params.set("status", query.status);
  if (query.page !== 1) params.set("page", String(query.page));
  if (query.pageSize !== 10) params.set("pageSize", String(query.pageSize));
  return params.size ? `?${params}` : "";
}
