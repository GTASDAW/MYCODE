import { safeActivityListPath } from "./activityDiscovery.ts";
import { myRegistrationListPath, parseMyRegistrationQuery } from "./myRegistrationQuery.ts";

// Dispatch only exact list paths. The public-list validator retains its narrower
// contract for callers that must never accept a protected personal destination.
export function safeActivityDetailReturn(value: unknown): string {
  if (typeof value !== "string" || /[\\\u0000-\u001f\u007f]/.test(value))
    return "/activities";
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
