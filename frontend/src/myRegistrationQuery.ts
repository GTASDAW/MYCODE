import type { MyRegistrationQuery, RegistrationFilter } from "./types";

export const defaultMyRegistrationQuery: MyRegistrationQuery = {
  page: 1,
  pageSize: 10,
  status: "ALL",
};

const statuses: RegistrationFilter[] = ["ALL", "ACTIVE", "WAITING", "CANCELLED"];

function positiveInteger(value: string | null, fallback: number, maximum: number) {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum
    ? number : fallback;
}

export function parseMyRegistrationQuery(search: string): MyRegistrationQuery {
  const params = new URLSearchParams(search);
  const status = params.get("status");
  return {
    page: positiveInteger(params.get("page"), 1, 2_147_483_647),
    pageSize: positiveInteger(params.get("pageSize"), 10, 100),
    status: statuses.includes(status as RegistrationFilter) ? status as RegistrationFilter : "ALL",
  };
}

export function serializeMyRegistrationQuery(query: MyRegistrationQuery): string {
  const params = new URLSearchParams();
  if (query.status !== "ALL") params.set("status", query.status);
  if (query.page !== 1) params.set("page", String(query.page));
  if (query.pageSize !== 10) params.set("pageSize", String(query.pageSize));
  return params.size ? `?${params}` : "";
}

export function myRegistrationListPath(query: MyRegistrationQuery): string {
  return `/my-registrations${serializeMyRegistrationQuery(query)}`;
}
