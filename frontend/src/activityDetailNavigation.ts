import { safeActivityListPath } from "./activityDiscovery.ts";
import { myRegistrationListPath, parseMyRegistrationQuery } from "./myRegistrationQuery.ts";
import { favoriteListPath, parseFavoriteQuery } from "./favoriteQuery.ts";
import { parseRosterQuery, rosterListPath } from "./rosterQuery.ts";

// Dispatch only exact list paths. The public-list validator retains its narrower
// contract for callers that must never accept a protected personal destination.
export function safeActivityDetailReturn(value: unknown, adminActivityId?: number): string {
  if (typeof value !== "string" || /[\\\u0000-\u001f\u007f]/.test(value))
    return "/activities";
  if (adminActivityId !== undefined && Number.isSafeInteger(adminActivityId) && adminActivityId > 0) {
    const path = `/admin/activities/${adminActivityId}/registrations`;
    if (value === path || value.startsWith(path + "?") && !value.includes("#")) {
      return rosterListPath(adminActivityId, parseRosterQuery(value.slice(path.length)).query);
    }
  }
  if (/^\/my-favorites(?:\?[^#]*)?$/.test(value)) {
    const start = value.indexOf("?");
    return favoriteListPath(parseFavoriteQuery(start === -1 ? "" : value.slice(start)));
  }
  if (/^\/my-registrations(?:\?[^#]*)?$/.test(value)) {
    const queryStart = value.indexOf("?");
    return myRegistrationListPath(parseMyRegistrationQuery(
      queryStart === -1 ? "" : value.slice(queryStart),
    ));
  }
  return safeActivityListPath(value);
}

export function myRegistrationDetailsPath(id: number, from: string): string {
  return `/activities/${id}?${new URLSearchParams({ from: safeActivityDetailReturn(from) })}`;
}
