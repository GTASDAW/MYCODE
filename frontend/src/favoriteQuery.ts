import type { FavoriteQuery } from "./types";

function integer(value: string | null, fallback: number, maximum: number) {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? number : fallback;
}
export function parseFavoriteQuery(search: string): FavoriteQuery {
  const params = new URLSearchParams(search);
  return {page: integer(params.get("page"), 1, 2_147_483_647), pageSize: integer(params.get("pageSize"), 10, 100)};
}
export function serializeFavoriteQuery(query: FavoriteQuery): string {
  const params = new URLSearchParams();
  if (query.page !== 1) params.set("page", String(query.page));
  if (query.pageSize !== 10) params.set("pageSize", String(query.pageSize));
  return params.size ? `?${params}` : "";
}
export function favoriteListPath(query: FavoriteQuery) { return `/my-favorites${serializeFavoriteQuery(query)}`; }
