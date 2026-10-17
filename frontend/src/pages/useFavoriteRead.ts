import { useLayoutEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { useAuth } from "../auth";
import { readAccountResource } from "../authRequestGuard";
import { useResource } from "../useResource";

export function useFavoriteRead<T>(loader: (signal: AbortSignal) => Promise<T>, scope: string) {
  const auth = useAuth();
  const account = auth.captureAccountRequest();
  const [revision, setRevision] = useState(0);
  const key = `${scope}:${account?.userId}:${account?.generation}:${revision}`;
  const live = useRef<string | null>(key);
  live.current = key;
  const current = () => live.current === key && !!account && auth.isCurrentAccountRequest(account);
  useLayoutEffect(() => {
    live.current = key;
    return () => { if (live.current === key) live.current = null; };
  }, [key]);
  const resource = useResource(signal => readAccountResource(loader, signal, current,
    error => { if (error instanceof ApiError && error.status === 401) auth.expire(); }), [key]);
  return {...resource, key, current, retry: () => setRevision(value => value + 1)};
}
