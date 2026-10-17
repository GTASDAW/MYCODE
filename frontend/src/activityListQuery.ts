import { parseActivityCategoryFilter } from "./activityCategory.ts";
import type { ActivityFilter, ActivitySearchQuery } from "./types";

const statuses: ActivityFilter[] = ["ALL", "OPEN", "FULL", "STARTED", "CANCELLED", "UPCOMING"];

function positiveInteger(value: string | null, fallback: number, maximum: number) {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? number : fallback;
}

export function readActivityListQuery(search: string, defaultPageSize: number, trimKeyword = false): {
  query: ActivitySearchQuery;
  notice: string | null;
} {
  const params = new URLSearchParams(search);
  const keyword = params.get("keyword") ?? "";
  const status = params.get("status");
  const validKeyword = keyword.length <= 200 ? keyword : "";
  return {
    query: {
      keyword: trimKeyword ? validKeyword.trim() : validKeyword,
      status: statuses.includes(status as ActivityFilter) ? status as ActivityFilter : "ALL",
      category: parseActivityCategoryFilter(params.get("category")),
      page: positiveInteger(params.get("page"), 1, 2_147_483_647),
      pageSize: positiveInteger(params.get("pageSize"), defaultPageSize, 100),
    },
    notice: keyword.length > 200
      ? "链接中的搜索关键词超过 200 个字符，已清空关键词；其他有效筛选条件保留。" : null,
  };
}

export function writeActivityListQuery(query: ActivitySearchQuery, defaultPageSize: number): string {
  const params = new URLSearchParams();
  if (query.keyword !== "") params.set("keyword", query.keyword);
  if (query.status !== "ALL") params.set("status", query.status);
  if (query.category && query.category !== "ALL") params.set("category", query.category);
  if (query.page !== 1) params.set("page", String(query.page));
  if (query.pageSize !== defaultPageSize) params.set("pageSize", String(query.pageSize));
  return params.size ? `?${params}` : "";
}
