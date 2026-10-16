import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { api, ApiError, errorMessage } from "./api";
import { AuthRequestGuard } from "./authRequestGuard";
import type { AccountRequest } from "./authRequestGuard";
import type { User } from "./types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  reload: () => Promise<void>;
  login: (username: string, password: string, signal?: AbortSignal) => Promise<void>;
  logout: () => Promise<void>;
  expire: () => void;
  readProfile: (signal: AbortSignal) => Promise<User>;
  updateProfile: (displayName: string, signal?: AbortSignal) => Promise<User>;
  captureAccountRequest: () => AccountRequest | null;
  isCurrentAccountRequest: (request: AccountRequest) => boolean;
  captureAuthenticationRequest: () => number;
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
  const publishUser = useCallback((current: User | null) => {
    currentUser.current = current;
    setUser(current);
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
  const logout = async () => {
    const currentGeneration = requests.current.beginAuthentication();
    await api.logout();
    if (!requests.current.isCurrentAuthentication(currentGeneration))
      throw new ApiError(
        0,
        "账号状态已改变，请重新检查登录状态。",
        "AUTH_STATE_CHANGED",
      );
    publishUser(null);
    setError(null);
    setNotice(null);
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
    publishUser(null);
    setError(null);
    setNotice(null);
    setLoading(false);
    // Synchronous completion lets the form clear and navigate before clearing
    // the user unmounts it and aborts its own already-completed refresh.
    onComplete({ generation, username, csrfReady });
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
    publishUser(null);
    setError(null);
    setNotice(null);
    setLoading(false);
    onComplete({ generation, username, csrfReady: true });
  }, [publishUser]);

  const readProfile = useCallback(async (signal: AbortSignal) => {
    const userId = currentUser.current?.id;
    if (userId === undefined)
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

  const updateProfile = useCallback(async (
    displayName: string,
    signal?: AbortSignal,
  ) => {
    const userId = currentUser.current?.id;
    if (userId === undefined)
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
      publishUser(current);
      return current;
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
        loading,
        error,
        notice,
        reload,
        login,
        logout,
        expire,
        readProfile,
        updateProfile,
        captureAccountRequest,
        isCurrentAccountRequest,
        captureAuthenticationRequest,
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
