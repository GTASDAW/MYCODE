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
import type { User } from "./types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  reload: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  expire: () => void;
  readProfile: (signal: AbortSignal) => Promise<User>;
  updateProfile: (displayName: string, signal?: AbortSignal) => Promise<User>;
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

  const login = async (username: string, password: string) => {
    const currentGeneration = requests.current.beginAuthentication();
    const current = await api.login(username, password);
    if (!requests.current.isCurrentAuthentication(currentGeneration))
      throw new ApiError(0, "登录操作已失效，请重试。", "AUTH_STATE_CHANGED");
    publishUser(current);
    setError(null);
    setNotice(null);
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
