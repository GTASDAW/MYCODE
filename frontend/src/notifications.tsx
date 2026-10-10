import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { api, ApiError } from "./api";
import { useAuth } from "./auth";
import type { AccountRequest } from "./authRequestGuard";
import { NotificationRequestOrder } from "./notificationRequestOrder";
import type { NotificationItem, NotificationPage, NotificationQuery } from "./types";

interface CountState {
  account: AccountRequest | null;
  value: number | null;
  loading: boolean;
  error: unknown;
}

interface NotificationContextValue {
  accountKey: string | null;
  unreadCount: number | null;
  countLoading: boolean;
  countError: unknown;
  loadNotifications: (query: NotificationQuery, signal: AbortSignal) => Promise<NotificationPage>;
  markRead: (id: number, signal: AbortSignal) => Promise<NotificationItem>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);
const cancelled = () => new DOMException("Notification request cancelled", "AbortError");

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { loading, error, captureAccountRequest, isCurrentAccountRequest, expire } = useAuth();
  const { pathname } = useLocation();
  const account = loading || error ? null : captureAccountRequest();
  const accountKey = account ? `${account.userId}:${account.generation}` : null;
  const notificationPageOpen = pathname === "/notifications";
  const order = useRef(new NotificationRequestOrder());
  const [count, setCount] = useState<CountState>({ account: null, value: null, loading: false, error: null });

  const loadNotifications = useCallback(async (query: NotificationQuery, signal: AbortSignal) => {
    const ticket = captureAccountRequest();
    if (!ticket || signal.aborted) throw cancelled();
    const read = order.current.beginRead();
    const current = () => !signal.aborted && isCurrentAccountRequest(ticket);
    setCount({ account: ticket, value: null, loading: true, error: null });
    try {
      const page = await api.notifications(query, signal);
      if (!current()) throw cancelled();
      if (order.current.isCurrent(read))
        setCount({ account: ticket, value: page.unreadCount, loading: false, error: null });
      return page;
    } catch (err) {
      if (!current()) throw cancelled();
      if (order.current.isCurrent(read)) {
        setCount({ account: ticket, value: null, loading: false, error: err });
        if (err instanceof ApiError && err.status === 401) expire();
      }
      throw err;
    }
  }, [captureAccountRequest, isCurrentAccountRequest, expire]);

  const markRead = useCallback(async (id: number, signal: AbortSignal) => {
    const ticket = captureAccountRequest();
    if (!ticket || signal.aborted) throw cancelled();
    const current = () => !signal.aborted && isCurrentAccountRequest(ticket);
    // Neither a read from before this write nor one taken during it may restore
    // the previous unread count after the write completes.
    order.current.invalidateReads();
    setCount({ account: ticket, value: null, loading: true, error: null });
    try {
      const item = await api.readNotification(id, signal);
      if (!current()) throw cancelled();
      order.current.invalidateReads();
      return item;
    } catch (err) {
      if (!current()) throw cancelled();
      order.current.invalidateReads();
      setCount({ account: ticket, value: null, loading: false, error: err });
      if (err instanceof ApiError && err.status === 401) expire();
      throw err;
    }
  }, [captureAccountRequest, isCurrentAccountRequest, expire]);

  useEffect(() => {
    // A list response includes the global unread count, so the notification
    // page owns its refresh without an additional count request.
    if (!accountKey || notificationPageOpen) return;
    const ticket = captureAccountRequest();
    if (!ticket) return;
    const controller = new AbortController();
    const read = order.current.beginRead();
    const current = () => !controller.signal.aborted &&
      isCurrentAccountRequest(ticket) && order.current.isCurrent(read);
    setCount({ account: ticket, value: null, loading: true, error: null });
    api.notificationUnreadCount(controller.signal).then(({ unreadCount }) => {
      if (current()) setCount({ account: ticket, value: unreadCount, loading: false, error: null });
    }).catch((err) => {
      if (!current()) return;
      setCount({ account: ticket, value: null, loading: false, error: err });
      if (err instanceof ApiError && err.status === 401) expire();
    });
    return () => controller.abort();
  }, [accountKey, notificationPageOpen, captureAccountRequest, isCurrentAccountRequest, expire]);

  const countBelongsToAccount = !!accountKey && !!count.account && isCurrentAccountRequest(count.account);
  return (
    <NotificationContext.Provider value={{
      accountKey,
      unreadCount: countBelongsToAccount ? count.value : null,
      countLoading: countBelongsToAccount ? count.loading : !!accountKey,
      countError: countBelongsToAccount ? count.error : null,
      loadNotifications,
      markRead,
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
