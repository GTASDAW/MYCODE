import { useEffect, useRef, useState } from "react";
import { ApiError, errorMessage } from "../api";
import { useAuth } from "../auth";

export function useRosterActions(pageKey: string) {
  const auth = useAuth();
  const currentPage = useRef(pageKey);
  currentPage.current = pageKey;
  const mounted = useRef(false);
  const submission = useRef<AbortController | null>(null);
  const [operation, setOperation] = useState<"checkIn" | "export" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    setOperation(null);
    setError(null);
    return () => {
      mounted.current = false;
      submission.current?.abort();
      submission.current = null;
    };
  }, [pageKey]);

  async function run<T>(
    kind: "checkIn" | "export",
    request: (signal: AbortSignal) => Promise<T>,
    onSuccess: (result: T, isCurrent: () => boolean) => void,
  ) {
    if (submission.current) return;
    const account = auth.captureAccountRequest();
    if (!account) return;
    const startedPage = pageKey;
    const controller = new AbortController();
    submission.current = controller;
    setOperation(kind);
    setError(null);
    const current = () => mounted.current && !controller.signal.aborted &&
      currentPage.current === startedPage && auth.isCurrentAccountRequest(account);
    try {
      const result = await request(controller.signal);
      if (current()) onSuccess(result, current);
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && err.status === 401) auth.expire();
      else setError(errorMessage(err));
    } finally {
      if (submission.current === controller) {
        submission.current = null;
        if (current()) setOperation(null);
      }
    }
  }

  return { operation, busy: operation !== null, error, clearError: () => setError(null), run };
}
