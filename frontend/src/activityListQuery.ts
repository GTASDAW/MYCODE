import { parseActivityCategoryFilter } from "./activityCategory.ts";
import { isActivityStartDate } from "./activityStartDate.ts";
import type { ActivityFilter, ActivitySearchQuery } from "./types";

const statuses: ActivityFilter[] = ["ALL", "OPEN", "FULL", "STARTED", "ONGOING", "ENDED", "CANCELLED", "UPCOMING"];

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
  const notices: string[] = [];
  if (keyword.length > 200)
    notices.push("链接中的搜索关键词超过 200 个字符，已清空关键词；其他有效筛选条件保留。");
  const from = params.get("startDateFrom");
  const to = params.get("startDateTo");
  let startDateFrom = from !== null && isActivityStartDate(from) ? from : undefined;
  let startDateTo = to !== null && isActivityStartDate(to) ? to : undefined;
  if (from !== null && !startDateFrom || to !== null && !startDateTo)
    notices.push("链接中的无效开始日期已清空；日期须为 2000-01-01 至 2100-12-31 之间的真实日期，其他有效筛选条件保留。");
  if (startDateFrom && startDateTo && startDateFrom > startDateTo) {
    startDateFrom = startDateTo = undefined;
    notices.push("链接中的开始日期（起）晚于开始日期（止），已清空两端日期；其他有效筛选条件保留。");
  }
  return {
    query: {
      keyword: trimKeyword ? validKeyword.trim() : validKeyword,
      status: statuses.includes(status as ActivityFilter) ? status as ActivityFilter : "ALL",
      category: parseActivityCategoryFilter(params.get("category")),
      ...(startDateFrom ? { startDateFrom } : {}),
      ...(startDateTo ? { startDateTo } : {}),
      page: positiveInteger(params.get("page"), 1, 2_147_483_647),
      pageSize: positiveInteger(params.get("pageSize"), defaultPageSize, 100),
    },
    notice: notices.length ? notices.join(" ") : null,
  };
}

export function writeActivityListQuery(query: ActivitySearchQuery, defaultPageSize: number): string {
  const params = new URLSearchParams();
  if (query.keyword !== "") params.set("keyword", query.keyword);
  if (query.status !== "ALL") params.set("status", query.status);
  if (query.category && query.category !== "ALL") params.set("category", query.category);
  if (query.startDateFrom) params.set("startDateFrom", query.startDateFrom);
  if (query.startDateTo) params.set("startDateTo", query.startDateTo);
  if (query.page !== 1) params.set("page", String(query.page));
  if (query.pageSize !== defaultPageSize) params.set("pageSize", String(query.pageSize));
  return params.size ? `?${params}` : "";
}
