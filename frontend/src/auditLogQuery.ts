import type { AdminAuditLogQuery, AuditLogActionFilter } from "./types";

export const defaultAuditLogQuery: AdminAuditLogQuery = {
  action: "ALL", activityId: null, page: 1, pageSize: 10,
};

const actions: AuditLogActionFilter[] = ["ALL", "CREATE", "EDIT", "CANCEL", "CHECK_IN"];

function positiveInteger(value: string | null, maximum: number): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? number : null;
}

export function parseAuditActivityId(value: string): number | null {
  return positiveInteger(value.trim(), Number.MAX_SAFE_INTEGER);
}

export function parseAuditLogQuery(search: string): AdminAuditLogQuery {
  const params = new URLSearchParams(search);
  const action = params.get("action");
  return {
    action: actions.includes(action as AuditLogActionFilter) ? action as AuditLogActionFilter : "ALL",
    activityId: positiveInteger(params.get("activityId"), Number.MAX_SAFE_INTEGER),
    page: positiveInteger(params.get("page"), 2_147_483_647) ?? 1,
    pageSize: positiveInteger(params.get("pageSize"), 100) ?? 10,
  };
}

export function serializeAuditLogQuery(query: AdminAuditLogQuery): string {
  const params = new URLSearchParams();
  if (query.action !== "ALL") params.set("action", query.action);
  if (query.page !== 1) params.set("page", String(query.page));
  if (query.pageSize !== 10) params.set("pageSize", String(query.pageSize));
  if (query.activityId !== null) params.set("activityId", String(query.activityId));
  return params.size ? `?${params}` : "";
}

export function auditLogListPath(query: AdminAuditLogQuery): string {
  return `/admin/audit-logs${serializeAuditLogQuery(query)}`;
}

export function activityAuditLogPath(activityId: number): string {
  return auditLogListPath({ ...defaultAuditLogQuery, activityId });
}
