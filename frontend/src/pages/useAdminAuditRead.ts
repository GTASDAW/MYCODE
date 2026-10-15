import { useLayoutEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { useAuth } from "../auth";
import { readAccountResource } from "../authRequestGuard";
import { useResource } from "../useResource";

// Each list/detail owns its request scope. The render-time key protects the
// interval before effect cleanup, including a queued 401 from an old drawer.
export function useAdminAuditRead<T>(loader: (signal: AbortSignal) => Promise<T>, scope: string) {
  const auth = useAuth();
  const [revision, setRevision] = useState(0);
  const account = auth.captureAccountRequest();
  const key = `${scope}:${account?.generation}:${account?.userId}:${auth.user?.role}:${revision}`;
  const currentKey = useRef<string | null>(key);
  currentKey.current = key;
  useLayoutEffect(() => {
    currentKey.current = key;
    return () => { if (currentKey.current === key) currentKey.current = null; };
  }, [key]);
  const resource = useResource((signal) => {
    const ticket = auth.captureAccountRequest();
    return readAccountResource(loader, signal,
      () => !!ticket && auth.user?.role === "ADMIN" && currentKey.current === key &&
        auth.isCurrentAccountRequest(ticket),
      error => { if (error instanceof ApiError && error.status === 401) auth.expire(); });
  }, [key]);
  return { ...resource, retry: () => setRevision(value => value + 1) };
}
