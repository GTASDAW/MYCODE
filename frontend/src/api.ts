import type {
  Activity,
  NewActivity,
  Registration,
  User,
  NewUser,
  AdminOverview,
  AdminMonitoring,
  AdminActivityQuery,
  AdminRegistrationQuery,
  AdminRegistrationPage,
  PageResult,
} from "./types";

interface CsrfToken {
  token: string;
  headerName: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(
    status: number,
    message: string,
    code = "REQUEST_FAILED",
    requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (
      requestId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        requestId,
      )
    )
      this.requestId = requestId;
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
  const requestId = response.headers.get("X-Request-Id") ?? undefined;
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        "服务暂时不可用，请稍后重试。",
        "INVALID_RESPONSE",
        requestId,
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
      requestId,
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
  me: (signal?: AbortSignal) => request<User>("/auth/me", { signal }),
  registerUser: (user: NewUser, signal?: AbortSignal) =>
    request<User>("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(user),
      signal,
    }),
  updateProfile: (displayName: string, signal?: AbortSignal) =>
    request<User>("/me/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName }),
      signal,
    }),
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
  adminOverview: (signal?: AbortSignal) =>
    request<AdminOverview>("/admin/overview", { signal }),
  adminMonitoring: (signal?: AbortSignal) =>
    request<AdminMonitoring>("/admin/monitoring", { signal }),
  adminActivities: (query: AdminActivityQuery, signal?: AbortSignal) =>
    request<PageResult<Activity>>(
      `/admin/activities?${new URLSearchParams({
        page: String(query.page),
        pageSize: String(query.pageSize),
        keyword: query.keyword,
        status: query.status,
      })}`,
      { signal },
    ),
  adminRegistrations: (
    id: string,
    query: AdminRegistrationQuery,
    signal?: AbortSignal,
  ) =>
    request<AdminRegistrationPage>(
      `/admin/activities/${encodeURIComponent(id)}/registrations?${new URLSearchParams(
        {
          page: String(query.page),
          pageSize: String(query.pageSize),
          status: query.status,
        },
      )}`,
      { signal },
    ),
  createActivity: (activity: NewActivity) =>
    request<Activity>("/admin/activities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(activity),
    }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status >= 500 && error.requestId)
    return `${error.message}（问题编号：${error.requestId}）`;
  return error instanceof Error ? error.message : "操作未完成，请稍后重试。";
}
