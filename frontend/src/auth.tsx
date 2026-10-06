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
import type { User } from "./types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  expire: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const currentGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      await api.refreshCsrf();
      const current = await api.me();
      if (generation.current === currentGeneration) setUser(current);
    } catch (err) {
      if (generation.current !== currentGeneration) return;
      if (err instanceof ApiError && err.status === 401) setUser(null);
      else setError(errorMessage(err));
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);

  const login = async (username: string, password: string) => {
    const currentGeneration = ++generation.current;
    const current = await api.login(username, password);
    if (generation.current !== currentGeneration)
      throw new ApiError(0, "登录操作已失效，请重试。", "AUTH_STATE_CHANGED");
    setUser(current);
    setError(null);
  };
  const logout = async () => {
    const currentGeneration = ++generation.current;
    await api.logout();
    if (generation.current !== currentGeneration)
      throw new ApiError(
        0,
        "账号状态已改变，请重新检查登录状态。",
        "AUTH_STATE_CHANGED",
      );
    setUser(null);
    setError(null);
  };
  const expire = useCallback(() => {
    generation.current++;
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        reload,
        login,
        logout,
        expire,
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
