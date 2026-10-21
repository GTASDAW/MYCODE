import { useLayoutEffect, useRef, useState } from "react";
import { App as AntApp } from "antd";
import { errorMessage } from "../api";
import { useAuth } from "../auth";
import { useNotifications } from "../notifications";

type Operation = number | "all" | null;
interface ActionState {
  pageKey: string;
  operation: Operation;
  confirmation: boolean;
  error: string | null;
}

export function useNotificationActions(pageKey: string, isPageCurrent: () => boolean, refresh: () => string) {
  const auth = useAuth();
  const { markRead, markAllRead } = useNotifications();
  const { message } = AntApp.useApp();
  const livePage = useRef<string | null>(pageKey);
  livePage.current = pageKey;
  const submission = useRef<AbortController | null>(null);
  const [state, setState] = useState<ActionState>({ pageKey, operation: null, confirmation: false, error: null });
  const visible = state.pageKey === pageKey;
  const operation = visible ? state.operation : null;

  useLayoutEffect(() => {
    livePage.current = pageKey;
    return () => {
      if (livePage.current === pageKey) livePage.current = null;
      submission.current?.abort();
      submission.current = null;
    };
  }, [pageKey]);

  async function run(kind: number | "all") {
    if (submission.current || livePage.current !== pageKey || !isPageCurrent()) return;
    const account = auth.captureAccountRequest();
    if (!account) return;
    const controller = new AbortController();
    submission.current = controller;
    setState({ pageKey, operation: kind, confirmation: kind === "all", error: null });
    const current = () => !controller.signal.aborted && livePage.current === pageKey &&
      submission.current === controller && isPageCurrent() && auth.isCurrentAccountRequest(account);
    try {
      const result = kind === "all"
        ? await markAllRead(controller.signal, current)
        : await markRead(kind, controller.signal, current);
      if (!current()) return;
      message.success(kind === "all" && "updatedCount" in result
        ? `已将 ${result.updatedCount} 条通知标为已读` : "已标记为已读");
      setState({ pageKey: refresh(), operation: null, confirmation: false, error: null });
    } catch (err) {
      if (!current()) return;
      // A lost response can follow a committed write. Read the actual state;
      // only a new explicit confirmation may send another POST.
      setState({ pageKey: refresh(), operation: null, confirmation: false, error: errorMessage(err) });
    } finally {
      if (submission.current === controller) {
        const stillCurrent = current();
        submission.current = null;
        if (stillCurrent) setState(previous => previous.pageKey === pageKey ? { ...previous, operation: null } : previous);
      }
    }
  }

  return {
    operation,
    busy: operation !== null,
    isBusy: () => submission.current !== null,
    error: visible ? state.error : null,
    confirmation: visible && state.confirmation,
    openConfirmation: () => {
      if (!submission.current && isPageCurrent()) setState({ pageKey, operation: null, confirmation: true, error: null });
    },
    closeConfirmation: () => {
      if (!submission.current && isPageCurrent()) setState({ pageKey, operation: null, confirmation: false, error: null });
    },
    carryError: (nextPageKey: string) => {
      if (isPageCurrent()) setState(previous => previous.pageKey === pageKey
        ? { ...previous, pageKey: nextPageKey, confirmation: false } : previous);
    },
    read: (id: number) => run(id),
    readAll: () => run("all"),
  };
}
