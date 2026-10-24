import { useLayoutEffect, useRef, useState } from "react";
import { ApiError, errorMessage } from "../api";
import { useAuth } from "../auth";

export function useRosterActions(pageKey: string, isCurrentPage: () => boolean) {
  const auth = useAuth();
  const currentPage = useRef(pageKey);
  currentPage.current = pageKey;
  const mounted = useRef(false);
  const submission = useRef<AbortController | null>(null);
  type Operation = "checkIn" | "correctCheckIn" | "export" | null;
  const [state, setState] = useState<{ pageKey: string; operation: Operation; error: string | null }>({ pageKey, operation: null, error: null });
  const operation = state.pageKey === pageKey ? state.operation : null;
  const error = state.pageKey === pageKey ? state.error : null;

  useLayoutEffect(() => {
    mounted.current = true;
    setState({ pageKey, operation: null, error: null });
    const unsubscribe = auth.subscribeAuthentication(() => submission.current?.abort());
    return () => {
      mounted.current = false;
      submission.current?.abort();
      submission.current = null;
      unsubscribe();
    };
  }, [pageKey, auth.subscribeAuthentication]);

  async function run<T>(
    kind: Exclude<Operation, null>,
    request: (signal: AbortSignal) => Promise<T>,
    onSuccess: (result: T, isCurrent: () => boolean) => void,
    onError?: (error: unknown) => void,
  ) {
    if (submission.current || !mounted.current || currentPage.current !== pageKey || !isCurrentPage()) return;
    const account = auth.captureAccountRequest();
    if (!account || auth.user?.role !== "ADMIN" || account.generation !== auth.userGeneration ||
        !auth.isCurrentAuthenticationRequest(auth.userGeneration)) return;
    const startedPage = pageKey;
    const controller = new AbortController();
    submission.current = controller;
    setState({ pageKey, operation: kind, error: null });
    const current = () => mounted.current && !controller.signal.aborted &&
      currentPage.current === startedPage && submission.current === controller && isCurrentPage() &&
      auth.isCurrentAuthenticationRequest(auth.userGeneration) && auth.isCurrentAccountRequest(account);
    try {
      const result = await request(controller.signal);
      if (current()) onSuccess(result, current);
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && err.status === 401) auth.expire();
      else {
        const unknownWrite = kind !== "export" && (!(err instanceof ApiError) || err.code === "NETWORK_ERROR" || err.code === "INVALID_RESPONSE");
        setState({ pageKey, operation: kind, error: unknownWrite
          ? "签到结果未确认，请刷新名单核对后再决定是否重试。" : errorMessage(err) });
        onError?.(err);
      }
    } finally {
      if (submission.current === controller) {
        const stillCurrent = current();
        submission.current = null;
        if (stillCurrent) setState(previous => previous.pageKey === pageKey ? { ...previous, operation: null } : previous);
      }
    }
  }

  return { operation, busy: operation !== null, error, clearError: () => {
    if (currentPage.current === pageKey && isCurrentPage()) setState(previous => previous.pageKey === pageKey ? { ...previous, error: null } : previous);
  }, run };
}
