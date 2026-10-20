import { useLayoutEffect, useRef, useState } from "react";
import { ApiError, errorMessage } from "../api";
import { useAuth } from "../auth";

export function useRosterActions(pageKey: string) {
  const auth = useAuth();
  const currentPage = useRef(pageKey);
  currentPage.current = pageKey;
  const mounted = useRef(false);
  const submission = useRef<AbortController | null>(null);
  type Operation = "checkIn" | "export" | null;
  const [state, setState] = useState<{ pageKey: string; operation: Operation; error: string | null }>({ pageKey, operation: null, error: null });
  const operation = state.pageKey === pageKey ? state.operation : null;
  const error = state.pageKey === pageKey ? state.error : null;

  useLayoutEffect(() => {
    mounted.current = true;
    setState({ pageKey, operation: null, error: null });
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
    if (submission.current || !mounted.current || currentPage.current !== pageKey) return;
    const account = auth.captureAccountRequest();
    if (!account || auth.user?.role !== "ADMIN") return;
    const startedPage = pageKey;
    const controller = new AbortController();
    submission.current = controller;
    setState({ pageKey, operation: kind, error: null });
    const current = () => mounted.current && !controller.signal.aborted &&
      currentPage.current === startedPage && submission.current === controller && auth.isCurrentAccountRequest(account);
    try {
      const result = await request(controller.signal);
      if (current()) onSuccess(result, current);
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && err.status === 401) auth.expire();
      else setState({ pageKey, operation: kind, error: errorMessage(err) });
    } finally {
      if (submission.current === controller) {
        const stillCurrent = current();
        submission.current = null;
        if (stillCurrent) setState(previous => previous.pageKey === pageKey ? { ...previous, operation: null } : previous);
      }
    }
  }

  return { operation, busy: operation !== null, error, clearError: () => {
    if (currentPage.current === pageKey) setState(previous => previous.pageKey === pageKey ? { ...previous, error: null } : previous);
  }, run };
}
