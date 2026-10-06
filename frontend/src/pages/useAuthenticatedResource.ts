import { useEffect } from "react";
import type { DependencyList } from "react";
import { ApiError } from "../api";
import { useAuth } from "../auth";
import { useResource } from "../useResource";

// Only mount these pages inside ProtectedRoute. Expired sessions return to that guard.
export function useAuthenticatedResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
) {
  const resource = useResource(loader, deps);
  const { expire } = useAuth();
  useEffect(() => {
    if (resource.error instanceof ApiError && resource.error.status === 401)
      expire();
  }, [resource.error, expire]);
  return resource;
}
