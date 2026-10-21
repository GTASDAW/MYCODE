import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { api, ApiError } from "./api";
import { useAuth } from "./auth";
import type { AccountRequest } from "./authRequestGuard";
import { NotificationRequests } from "./notificationRequests";
import type { NotificationItem, NotificationPage, NotificationQuery, NotificationReadAllResult } from "./types";

interface CountState {
  account: AccountRequest | null;
  scope: string;
  value: number | null;
  loading: boolean;
  error: unknown;
}

type PageCurrent = () => boolean;
interface NotificationContextValue {
  accountKey: string | null;
  unreadCount: number | null;
  countLoading: boolean;
  countError: unknown;
  loadNotifications: (query: NotificationQuery, signal: AbortSignal, isCurrent?: PageCurrent) => Promise<NotificationPage>;
  markRead: (id: number, signal: AbortSignal, isCurrent?: PageCurrent) => Promise<NotificationItem>;
  markAllRead: (signal: AbortSignal, isCurrent?: PageCurrent) => Promise<NotificationReadAllResult>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);
const cancelled = () => new DOMException("Notification request cancelled", "AbortError");
const alwaysCurrent = () => true;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { loading, error, captureAccountRequest, isCurrentAccountRequest, expire } = useAuth();
  const { pathname } = useLocation();
  const account = loading || error ? null : captureAccountRequest();
  const accountKey = account ? `${account.userId}:${account.generation}` : null;
  const notificationPageOpen = pathname === "/notifications" || pathname === "/notifications/";
  const scope = `${notificationPageOpen ? "notifications" : "outside"}:${accountKey}`;
  const liveScope = useRef<string | null>(scope);
  liveScope.current = scope;
  const requests = useRef(new NotificationRequests());
  const [count, setCount] = useState<CountState>({ account: null, scope, value: null, loading: false, error: null });

  useLayoutEffect(() => {
    liveScope.current = scope;
    return () => { if (liveScope.current === scope) liveScope.current = null; };
  }, [scope]);

  const requestOptions = useCallback((signal: AbortSignal, isPageCurrent: PageCurrent = alwaysCurrent) => {
    const ticket = captureAccountRequest();
    const startedScope = liveScope.current;
    if (!ticket || !startedScope || signal.aborted || !isPageCurrent()) throw cancelled();
    return {
      signal,
      isCurrent: () => liveScope.current === startedScope && isCurrentAccountRequest(ticket) && isPageCurrent(),
      onStart: () => setCount({ account: ticket, scope: startedScope, value: null, loading: true, error: null }),
      onError: (err: unknown) => {
        setCount({ account: ticket, scope: startedScope, value: null, loading: false, error: err });
        if (err instanceof ApiError && err.status === 401) expire();
      },
      onCount: (value: number) => setCount({ account: ticket, scope: startedScope, value, loading: false, error: null }),
    };
  }, [captureAccountRequest, isCurrentAccountRequest, expire]);

  const loadNotifications = useCallback(async (query: NotificationQuery, signal: AbortSignal, isCurrent?: PageCurrent) => {
    const options = requestOptions(signal, isCurrent);
    return requests.current.read({ ...options, request: requestSignal => api.notifications(query, requestSignal),
      onSuccess: page => options.onCount(page.unreadCount) });
  }, [requestOptions]);

  const markRead = useCallback(async (id: number, signal: AbortSignal, isCurrent?: PageCurrent) => {
    const options = requestOptions(signal, isCurrent);
    return requests.current.write({ ...options, request: requestSignal => api.readNotification(id, requestSignal),
      onSuccess: () => {} });
  }, [requestOptions]);

  const markAllRead = useCallback(async (signal: AbortSignal, isCurrent?: PageCurrent) => {
    const options = requestOptions(signal, isCurrent);
    return requests.current.write({ ...options, request: api.readAllNotifications, onSuccess: () => {} });
  }, [requestOptions]);

  useEffect(() => {
    // List snapshots include the global count, regardless of their filters.
    if (!accountKey || notificationPageOpen) return;
    const controller = new AbortController();
    const current = () => liveScope.current === scope && !!account && isCurrentAccountRequest(account);
    if (!current()) return;
    const options = requestOptions(controller.signal, current);
    void requests.current.read({ ...options, request: api.notificationUnreadCount,
      onSuccess: result => options.onCount(result.unreadCount) }).catch(() => {
      // The owned onError already published current failures; stale work is silent.
    });
    return () => controller.abort();
  }, [accountKey, notificationPageOpen, scope, requestOptions, isCurrentAccountRequest]);

  const countBelongsToScope = !!accountKey && count.scope === scope && !!count.account && isCurrentAccountRequest(count.account);
  return (
    <NotificationContext.Provider value={{
      accountKey,
      unreadCount: countBelongsToScope ? count.value : null,
      countLoading: countBelongsToScope ? count.loading : !!accountKey,
      countError: countBelongsToScope ? count.error : null,
      loadNotifications,
      markRead,
      markAllRead,
    }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) throw new Error("NotificationProvider is required");
  return context;
}
