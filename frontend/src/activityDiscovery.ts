import type { ActivityFilter, ActivitySearchQuery } from "./types";

export const defaultActivityQuery: ActivitySearchQuery = {
  keyword: "",
  status: "ALL",
  page: 1,
  pageSize: 12,
};

const statuses: ActivityFilter[] = [
  "ALL", "OPEN", "FULL", "STARTED", "CANCELLED", "UPCOMING",
];

function positiveInteger(value: string | null, fallback: number, maximum: number) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum
    ? number
    : fallback;
}

export function parseActivityQuery(search: string): {
  query: ActivitySearchQuery;
  notice: string | null;
} {
  const params = new URLSearchParams(search);
  const keyword = params.get("keyword") ?? "";
  const status = params.get("status");
  return {
    query: {
      keyword: keyword.length <= 200 ? keyword : "",
      status: statuses.includes(status as ActivityFilter)
        ? (status as ActivityFilter)
        : "ALL",
      page: positiveInteger(params.get("page"), 1, 2_147_483_647),
      pageSize: positiveInteger(params.get("pageSize"), 12, 100),
    },
    notice: keyword.length > 200
      ? "链接中的搜索关键词超过 200 个字符，已清空关键词；其他有效筛选条件保留。"
      : null,
  };
}

export function serializeActivityQuery(query: ActivitySearchQuery): string {
  const params = new URLSearchParams();
  if (query.keyword !== "") params.set("keyword", query.keyword);
  if (query.status !== "ALL") params.set("status", query.status);
  if (query.page !== 1) params.set("page", String(query.page));
  if (query.pageSize !== 12) params.set("pageSize", String(query.pageSize));
  return params.size ? `?${params}` : "";
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
