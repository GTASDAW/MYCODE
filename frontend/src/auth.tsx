import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { api, ApiError, errorMessage } from "./api";
import { AuthRequestGuard } from "./authRequestGuard";
import type { AccountRequest } from "./authRequestGuard";
import type { User } from "./types";
import { safeAvatarUrl } from "./accountAvatar";
import { useAccountAvatar } from "./useAccountAvatar";
import { confirmLogoutSession } from "./authRecovery";

interface AuthContextValue {
  user: User | null;
  userGeneration: number;
  loading: boolean;
  error: string | null;
  notice: string | null;
  reload: () => Promise<void>;
  login: (username: string, password: string, signal?: AbortSignal) => Promise<void>;
  logout: (signal?: AbortSignal) => Promise<void>;
  expire: () => void;
  readProfile: (signal: AbortSignal) => Promise<User>;
  updateProfile: (displayName: string, signal?: AbortSignal) => Promise<User>;
  updateAvatar: (file: File | null, signal: AbortSignal) => Promise<User>;
  avatarSource: string | null;
  captureAccountRequest: () => AccountRequest | null;
  isCurrentAccountRequest: (request: AccountRequest) => boolean;
  captureAuthenticationRequest: () => number;
  subscribeAuthentication: (listener: () => void) => () => void;
  isCurrentAuthenticationRequest: (generation: number) => boolean;
  completePasswordChange: (request: AccountRequest, signal: AbortSignal, onComplete: (result: PasswordSignOutResult) => void) => Promise<void>;
  signOutToConfirmPassword: (request: AccountRequest, signal: AbortSignal, onComplete: (result: PasswordSignOutResult) => void) => Promise<void>;
}

export interface PasswordSignOutResult {
  generation: number;
  username: string;
  csrfReady: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requests = useRef(new AuthRequestGuard());
  const currentUser = useRef<User | null>(null);
  const [publishedGeneration, setPublishedGeneration] = useState(0);
  const publishedUserGeneration = useRef(0);
  const publishUser = useCallback((current: User | null) => {
    const safe = current ? { ...current, avatarUrl: safeAvatarUrl(current.avatarUrl) } : null;
    currentUser.current = safe;
    publishedUserGeneration.current = requests.current.captureAuthentication();
    setUser(safe);
    setPublishedGeneration(requests.current.captureAuthentication());
  }, []);

  const reload = useCallback(async () => {
    const currentGeneration = requests.current.beginAuthentication();
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await api.refreshCsrf();
      const current = await api.me();
      if (requests.current.isCurrentAuthentication(currentGeneration))
        publishUser(current);
    } catch (err) {
      if (!requests.current.isCurrentAuthentication(currentGeneration)) return;
      if (err instanceof ApiError && err.status === 401) publishUser(null);
      else setError(errorMessage(err));
    } finally {
      if (requests.current.isCurrentAuthentication(currentGeneration))
        setLoading(false);
    }
  }, [publishUser]);

  useEffect(() => {
    void reload();
    return () => {
      requests.current.beginAuthentication();
    };
  }, [reload]);

  const login = async (username: string, password: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const currentGeneration = requests.current.beginAuthentication();
    const isCurrent = () => !signal?.aborted &&
      requests.current.isCurrentAuthentication(currentGeneration);
    try {
      const current = await api.login(username, password, signal);
      if (!isCurrent())
        throw new DOMException("Login request cancelled", "AbortError");
      publishUser(current);
      setError(null);
      setNotice(null);
    } catch (err) {
      if (!isCurrent())
        throw new DOMException("Login request cancelled", "AbortError");
      throw err;
    }
  };
  const logout = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const currentGeneration = requests.current.beginAuthentication();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const unsubscribe = requests.current.subscribeAuthentication(abort);
    const isCurrent = () => !controller.signal.aborted && requests.current.isCurrentAuthentication(currentGeneration);
    const cancelled = () => new DOMException("Logout authentication changed", "AbortError");
    try {
      try {
        await api.logout(controller.signal);
      } catch {
        if (!isCurrent()) throw cancelled();
        let confirmed: Awaited<ReturnType<typeof confirmLogoutSession>>;
        try {
          confirmed = await confirmLogoutSession({ signal: controller.signal, isCurrent,
            readSession: api.me, refreshCsrf: recoverySignal => api.refreshCsrf(recoverySignal, true) });
        } catch {
          if (!isCurrent()) throw cancelled();
          const message = "退出结果未确认，请重新登录确认。";
          publishUser(null); setError(message); setNotice(message);
          throw new ApiError(0, message, "LOGOUT_UNCONFIRMED");
        }
        if (!isCurrent()) throw cancelled();
        publishUser(confirmed.user);
        setNotice(null);
        setError(confirmed.csrfReady ? null : "安全凭证暂不可用，请重新加载页面后重试。");
        if (confirmed.user) throw new ApiError(0, confirmed.csrfReady
          ? "退出未完成，当前仍处于登录状态，请重试。"
          : "退出未完成，当前仍处于登录状态。安全凭证暂不可用，请重新加载页面后重试。", "LOGOUT_NOT_COMPLETED");
        return;
      }
      if (!isCurrent()) throw cancelled();
      publishUser(null);
      setError(null);
      setNotice(null);
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", abort);
    }
  };
  const expire = useCallback(() => {
    requests.current.beginAuthentication();
    publishUser(null);
    setError(null);
    setNotice("登录已过期，请重新登录后继续。");
    setLoading(false);
  }, [publishUser]);

  const captureAccountRequest = useCallback(() => {
    const userId = currentUser.current?.id;
    return userId === undefined ? null : requests.current.beginAccountRequest(userId);
  }, []);
  const isCurrentAccountRequest = useCallback((request: AccountRequest) =>
    requests.current.isSameAccount(request, currentUser.current?.id), []);

  const captureAuthenticationRequest = useCallback(() =>
    requests.current.captureAuthentication(), []);
  const subscribeAuthentication = useCallback((listener: () => void) =>
    requests.current.subscribeAuthentication(listener), []);
  const isCurrentAuthenticationRequest = useCallback((generation: number) =>
    requests.current.isCurrentAuthentication(generation), []);

  const completePasswordChange = useCallback(async (
    ticket: AccountRequest, signal: AbortSignal, onComplete: (result: PasswordSignOutResult) => void,
  ) => {
    const cancelled = () => new DOMException("Password authentication changed", "AbortError");
    if (signal.aborted || !requests.current.isSameAccount(ticket, currentUser.current?.id)) throw cancelled();
    const username = currentUser.current!.username;
    // Invalidate old profile/notification reads before obtaining the anonymous
    // CSRF token. Keep the form mounted until that owned refresh is finished.
    const generation = requests.current.beginAuthentication();
    const current = () => !signal.aborted && requests.current.isCurrentAuthentication(generation);
    let csrfReady = true;
    try { await api.refreshCsrf(signal, true); }
    catch (error) {
      if (!current()) throw cancelled();
      // The POST already confirmed the password change. A refresh failure must
      // not misreport that confirmed result as an unknown password outcome.
      csrfReady = false;
    }
    if (!current()) throw cancelled();
    // BrowserRouter schedules navigation as a transition. Schedule the identity
    // update with it so ProtectedRoute cannot redirect an intermediate null user
    // and replace the confirmed login notice/username with its generic state.
    startTransition(() => {
      publishUser(null);
      setError(null);
      setNotice(null);
      setLoading(false);
      onComplete({ generation, username, csrfReady });
    });
  }, [publishUser]);

  const signOutToConfirmPassword = useCallback(async (
    ticket: AccountRequest, signal: AbortSignal, onComplete: (result: PasswordSignOutResult) => void,
  ) => {
    const current = () => !signal.aborted && requests.current.isSameAccount(ticket, currentUser.current?.id);
    const cancelled = () => new DOMException("Password confirmation cancelled", "AbortError");
    if (!current()) throw cancelled();
    const username = currentUser.current!.username;
    try { await api.logout(signal); }
    catch (error) {
      if (!current()) throw cancelled();
      throw error;
    }
    if (!current()) throw cancelled();
    const generation = requests.current.beginAuthentication();
    startTransition(() => {
      publishUser(null);
      setError(null);
      setNotice(null);
      setLoading(false);
      onComplete({ generation, username, csrfReady: true });
    });
  }, [publishUser]);

  const readProfile = useCallback(async (signal: AbortSignal) => {
    const userId = currentUser.current?.id;
    if (userId === undefined || !requests.current.isCurrentAuthentication(publishedUserGeneration.current))
      throw new DOMException("Authentication changed", "AbortError");
    const ticket = requests.current.beginProfileRead(userId);
    try {
      const current = await api.me(signal);
      if (
        signal.aborted ||
        !requests.current.isSameAccount(ticket, currentUser.current?.id)
      )
        throw new DOMException("Profile request cancelled", "AbortError");
      if (!requests.current.isCurrentProfileRead(ticket, currentUser.current?.id))
        throw new DOMException("Profile request superseded", "AbortError");
      if (current.id !== userId) {
        expire();
        throw new DOMException("Authentication changed", "AbortError");
      }
      publishUser(current);
      return current;
    } catch (err) {
      if (
        signal.aborted ||
        !requests.current.isSameAccount(ticket, currentUser.current?.id)
      )
        throw new DOMException("Profile request cancelled", "AbortError");
      if (!requests.current.isCurrentProfileRead(ticket, currentUser.current?.id))
        throw new DOMException("Profile request superseded", "AbortError");
      if (err instanceof ApiError && err.status === 401) expire();
      throw err;
    }
  }, [expire, publishUser]);

  const updateAvatar = useCallback(async (file: File | null, signal: AbortSignal) => {
    signal.throwIfAborted();
    const userId = currentUser.current?.id;
    if (userId === undefined || !requests.current.isCurrentAuthentication(publishedUserGeneration.current))
      throw new DOMException("Authentication changed", "AbortError");
    const ticket = requests.current.beginAvatarWrite(userId);
    const current = () => !signal.aborted && requests.current.isCurrentAvatarWrite(ticket, currentUser.current?.id);
    try {
      const updated = file ? await api.uploadAvatar(file, signal) : await api.removeAvatar(signal);
      if (!current() || !requests.current.finishAvatarWrite(ticket, currentUser.current?.id))
        throw new DOMException("Avatar request cancelled", "AbortError");
      if (updated.id !== userId) {
        expire();
        throw new DOMException("Authentication changed", "AbortError");
      }
      const merged = { ...currentUser.current!, avatarUrl: safeAvatarUrl(updated.avatarUrl) };
      publishUser(merged);
      return merged;
    } catch (error) {
      if (!current()) throw new DOMException("Avatar request cancelled", "AbortError");
      if (error instanceof ApiError && error.status === 401) expire();
      throw error;
    } finally {
      // Even a rejected/abandoned upload invalidated the preceding image read.
      // Publish that revision so the shared image hook fetches the real avatar again.
      requests.current.publishAvatarRevision(ticket, currentUser.current?.id);
    }
  }, [expire, publishUser]);

  const readAvatar = useCallback(async (url: string, signal: AbortSignal) => {
    const userId = currentUser.current?.id;
    if (userId === undefined || !requests.current.isCurrentAuthentication(publishedUserGeneration.current))
      throw new DOMException("Authentication changed", "AbortError");
    const ticket = requests.current.beginAvatarRead(userId);
    const current = () => !signal.aborted && requests.current.isCurrentAvatarRead(ticket, currentUser.current?.id) &&
      currentUser.current?.avatarUrl === url;
    try {
      const blob = await api.avatar(url, signal);
      if (!current()) throw new DOMException("Avatar read cancelled", "AbortError");
      return blob;
    } catch (error) {
      if (!current()) throw new DOMException("Avatar read cancelled", "AbortError");
      if (error instanceof ApiError && error.status === 401) expire();
      throw error;
    }
  }, [expire]);
  const subscribeAvatarRevision = useCallback((listener: () => void) => requests.current.subscribeAvatarRevision(listener), []);
  const captureAvatarVersion = useCallback(() => requests.current.captureAvatarVersion(), []);
  const avatarRevision = useSyncExternalStore(subscribeAvatarRevision, captureAvatarVersion);
  const avatarSource = useAccountAvatar({ user, generation: publishedGeneration,
    revision: avatarRevision, read: readAvatar,
    isCurrent: isCurrentAuthenticationRequest, subscribe: subscribeAuthentication });

  const updateProfile = useCallback(async (
    displayName: string,
    signal?: AbortSignal,
  ) => {
    const userId = currentUser.current?.id;
    if (userId === undefined || !requests.current.isCurrentAuthentication(publishedUserGeneration.current))
      throw new DOMException("Authentication changed", "AbortError");
    const ticket = requests.current.beginProfileWrite(userId);
    try {
      const current = await api.updateProfile(displayName, signal);
      if (
        signal?.aborted ||
        !requests.current.finishProfileWrite(ticket, currentUser.current?.id)
      )
        throw new DOMException("Profile request cancelled", "AbortError");
      if (current.id !== userId) {
        expire();
        throw new DOMException("Authentication changed", "AbortError");
      }
      // Nickname and avatar writes can finish independently; only this field
      // belongs to the nickname response.
      const merged = { ...currentUser.current!, displayName: current.displayName };
      publishUser(merged);
      return merged;
    } catch (err) {
      if (
        signal?.aborted ||
        !requests.current.isCurrentProfileWrite(ticket, currentUser.current?.id)
      )
        throw new DOMException("Profile request cancelled", "AbortError");
      if (err instanceof ApiError && err.status === 401) expire();
      throw err;
    }
  }, [expire, publishUser]);

  return (
    <AuthContext.Provider
      value={{
        user,
        userGeneration: publishedGeneration,
        loading,
        error,
        notice,
        reload,
        login,
        logout,
        expire,
        readProfile,
        updateProfile,
        updateAvatar,
        avatarSource,
        captureAccountRequest,
        isCurrentAccountRequest,
        captureAuthenticationRequest,
        subscribeAuthentication,
        isCurrentAuthenticationRequest,
        completePasswordChange,
        signOutToConfirmPassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is required");
  return value;
}
