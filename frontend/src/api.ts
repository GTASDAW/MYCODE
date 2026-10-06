import type { Activity, NewActivity, Registration, User } from "./types";

interface CsrfToken {
  token: string;
  headerName: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = "REQUEST_FAILED") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let csrf: CsrfToken | null = null;
let csrfPromise: Promise<CsrfToken> | null = null;

async function request<T>(
  path: string,
  options: RequestInit = {},
  allowCsrfRetry = true,
): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (method !== "GET" && method !== "HEAD") {
    const token = csrf ?? (await getCsrf());
    headers.set(token.headerName, token.token);
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers,
      credentials: "same-origin",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(
      0,
      "暂时无法连接服务，请检查网络后重试。",
      "NETWORK_ERROR",
    );
  }

  let body: unknown;
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        "服务暂时不可用，请稍后重试。",
        "INVALID_RESPONSE",
      );
    }
  }
  if (!response.ok) {
    const details = body as { message?: string; code?: string } | undefined;
    if (
      allowCsrfRetry &&
      method !== "GET" &&
      method !== "HEAD" &&
      response.status === 403 &&
      details?.code === "CSRF_INVALID"
    ) {
      await refreshCsrf();
      return request<T>(path, options, false);
    }
    const fallback =
      response.status === 401
        ? "登录已过期，请重新登录。"
        : response.status === 403
          ? "无法完成操作，请刷新页面后重试或检查账号权限。"
          : "操作未完成，请稍后重试。";
    throw new ApiError(
      response.status,
      details?.message || fallback,
      details?.code,
    );
  }
  return body as T;
}

async function getCsrf(): Promise<CsrfToken> {
  if (csrf) return csrf;
  if (!csrfPromise) {
    csrfPromise = request<CsrfToken>("/auth/csrf")
      .then((token) => {
        csrf = token;
        return token;
      })
      .finally(() => {
        csrfPromise = null;
      });
  }
  return csrfPromise;
}

async function refreshCsrf(): Promise<void> {
  csrf = null;
  await getCsrf();
}

export const api = {
  refreshCsrf,
  me: () => request<User>("/auth/me"),
  login: async (username: string, password: string) => {
    const user = await request<User>("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
    });
    await refreshCsrf();
    return user;
  },
  logout: async () => {
    await request("/auth/logout", { method: "POST" });
    await refreshCsrf();
  },
  activities: (signal?: AbortSignal) =>
    request<Activity[]>("/activities", { signal }),
  activity: (id: string, signal?: AbortSignal) =>
    request<Activity>(`/activities/${encodeURIComponent(id)}`, { signal }),
  register: (id: number) =>
    request<Activity>(`/activities/${id}/registration`, { method: "POST" }),
  cancel: (id: number) =>
    request<Activity>(`/activities/${id}/registration`, { method: "DELETE" }),
  registrations: (signal?: AbortSignal) =>
    request<Registration[]>("/me/registrations", { signal }),
  createActivity: (activity: NewActivity) =>
    request<Activity>("/admin/activities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(activity),
    }),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请稍后重试。";
}
