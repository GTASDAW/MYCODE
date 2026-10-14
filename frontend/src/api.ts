import type {
  Activity,
  ActivityDetails,
  NewActivity,
  Registration,
  MyRegistrationQuery,
  MyRegistrationPage,
  User,
  NewUser,
  AdminOverview,
  AdminMonitoring,
  AdminActivityQuery,
  AdminRegistrationQuery,
  AdminRegistrationPage,
  AdminRegistration,
  PageResult,
  ActivitySearchQuery,
  ActivitySearchPage,
  NotificationQuery,
  NotificationPage,
  NotificationItem,
} from "./types";

interface CsrfToken {
  token: string;
  headerName: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    message: string,
    code = "REQUEST_FAILED",
    requestId?: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (status === 429 && code === "AUTH_RATE_LIMITED")
      this.retryAfterSeconds = validRetrySeconds(retryAfterSeconds);
    if (
      requestId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        requestId,
      )
    )
      this.requestId = requestId;
  }
}

// Only a bounded delta in seconds is accepted; HTTP dates and malformed values
// must not keep an authentication form disabled indefinitely.
function validRetrySeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value > 0 && value <= 86_400 ? value : undefined;
}

function authenticationRetrySeconds(body: unknown, header: string | null): number | undefined {
  const details = body as { retryAfterSeconds?: unknown } | null;
  const jsonSeconds = validRetrySeconds(details?.retryAfterSeconds);
  const headerSeconds = header && /^[1-9]\d{0,4}$/.test(header)
    ? validRetrySeconds(Number(header)) : undefined;
  // Waiting for the longer valid value avoids retrying before either server
  // representation permits it. The next attempt is always a user action.
  if (jsonSeconds !== undefined && headerSeconds !== undefined)
    return Math.max(jsonSeconds, headerSeconds);
  return jsonSeconds ?? headerSeconds;
}

let csrf: CsrfToken | null = null;
let csrfVersion = 0;
let csrfPromise: {
  version: number;
  signal?: AbortSignal;
  promise: Promise<CsrfToken>;
} | null = null;

function beginCsrfTransition(): number {
  // The cached token can still authorize the login/logout POST. Any pending
  // refresh belongs to the preceding transition and must not supply its token.
  csrfPromise = null;
  return ++csrfVersion;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  allowCsrfRetry = true,
  responseType: "json" | "csv" = "json",
): Promise<T> {
  options.signal?.throwIfAborted();
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers);
  headers.set("Accept", responseType === "csv" ? "text/csv, application/json" : "application/json");
  if (method !== "GET" && method !== "HEAD") {
    const token = csrf ?? (await getCsrf());
    headers.set(token.headerName, token.token);
  }
  options.signal?.throwIfAborted();

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
  if (response.ok && responseType === "csv") {
    if (response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "text/csv")
      throw new ApiError(response.status, "导出文件格式异常，请稍后重试。", "INVALID_RESPONSE", requestId);
    try {
      return await response.blob() as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiError(response.status, "导出文件读取失败，请稍后重试。", "INVALID_RESPONSE", requestId);
    }
  }
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiError(
        response.status,
        "服务暂时不可用，请稍后重试。",
        "INVALID_RESPONSE",
        requestId,
      );
    }
  }
  options.signal?.throwIfAborted();
  if (!response.ok) {
    const details = body as { message?: string; code?: string } | undefined;
    if (
      allowCsrfRetry &&
      method !== "GET" &&
      method !== "HEAD" &&
      response.status === 403 &&
      details?.code === "CSRF_INVALID"
    ) {
      await refreshCsrf(options.signal ?? undefined);
      return request<T>(path, options, false, responseType);
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
      response.status === 429 && details?.code === "AUTH_RATE_LIMITED"
        ? authenticationRetrySeconds(body, response.headers.get("Retry-After"))
        : undefined,
    );
  }
  return body as T;
}

async function getCsrf(signal?: AbortSignal): Promise<CsrfToken> {
  signal?.throwIfAborted();
  if (csrf) return csrf;
  if (csrfPromise && (csrfPromise.signal?.aborted || csrfPromise.version !== csrfVersion))
    beginCsrfTransition();
  if (!csrfPromise) {
    const version = csrfVersion;
    const isCurrent = () => !signal?.aborted && version === csrfVersion;
    const cancelled = () => new DOMException("CSRF refresh cancelled", "AbortError");
    const promise = request<CsrfToken>("/auth/csrf", { signal })
      .then((token) => {
        if (!isCurrent()) throw cancelled();
        csrf = token;
        return token;
      })
      .catch((error: unknown) => {
        if (!isCurrent()) throw cancelled();
        throw error;
      })
      .finally(() => {
        // A stale refresh must not erase a newer refresh's shared promise.
        if (csrfPromise?.promise === promise) csrfPromise = null;
      });
    csrfPromise = { version, signal, promise };
  }
  return csrfPromise.promise;
}

async function refreshCsrf(signal?: AbortSignal, newSession = false): Promise<void> {
  signal?.throwIfAborted();
  csrf = null;
  if (newSession) beginCsrfTransition();
  // Initialization and ordinary CSRF recovery share an unbound read. A
  // successful authentication owns its new, cancellable refresh instead.
  await getCsrf(newSession ? signal : undefined);
  signal?.throwIfAborted();
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
  login: async (username: string, password: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const version = beginCsrfTransition();
    const user = await request<User>("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
      signal,
    });
    signal?.throwIfAborted();
    if (version !== csrfVersion)
      throw new DOMException("Login refresh superseded", "AbortError");
    await refreshCsrf(signal, true);
    signal?.throwIfAborted();
    return user;
  },
  logout: async () => {
    const version = beginCsrfTransition();
    await request("/auth/logout", { method: "POST" });
    if (version !== csrfVersion)
      throw new DOMException("Logout refresh superseded", "AbortError");
    await refreshCsrf(undefined, true);
  },
  activities: (signal?: AbortSignal) =>
    request<Activity[]>("/activities", { signal }),
  searchActivities: (query: ActivitySearchQuery, signal?: AbortSignal) =>
    request<ActivitySearchPage>(
      `/activities/search?${new URLSearchParams({
        keyword: query.keyword,
        status: query.status,
        page: String(query.page),
        pageSize: String(query.pageSize),
      })}`,
      { signal },
    ),
  activity: (id: string, signal?: AbortSignal) =>
    request<Activity>(`/activities/${encodeURIComponent(id)}`, { signal }),
  register: (id: number, signal?: AbortSignal) =>
    request<Activity>(`/activities/${id}/registration`, { method: "POST", signal }),
  cancel: (id: number, signal?: AbortSignal) =>
    request<Activity>(`/activities/${id}/registration`, { method: "DELETE", signal }),
  registrations: (signal?: AbortSignal) =>
    request<Registration[]>("/me/registrations", { signal }),
  searchRegistrations: (query: MyRegistrationQuery, signal?: AbortSignal) =>
    request<MyRegistrationPage>(
      `/me/registrations/search?${new URLSearchParams({
        page: String(query.page),
        pageSize: String(query.pageSize),
        status: query.status,
      })}`,
      { signal },
    ),
  notifications: (query: NotificationQuery, signal?: AbortSignal) =>
    request<NotificationPage>(
      `/me/notifications?${new URLSearchParams({
        page: String(query.page),
        pageSize: String(query.pageSize),
        status: query.status,
      })}`,
      { signal },
    ),
  notificationUnreadCount: (signal?: AbortSignal) =>
    request<{ unreadCount: number }>("/me/notifications/unread-count", { signal }),
  readNotification: (id: number, signal?: AbortSignal) =>
    request<NotificationItem>(`/me/notifications/${id}/read`, { method: "POST", signal }),
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
          checkInStatus: query.checkInStatus,
        },
      )}`,
      { signal },
    ),
  checkInRegistration: (id: string, registrationId: number, signal?: AbortSignal) =>
    request<AdminRegistration>(`/admin/activities/${encodeURIComponent(id)}/registrations/${registrationId}/check-in`, {
      method: "POST", signal,
    }),
  exportAdminRegistrations: (
    id: string,
    query: Pick<AdminRegistrationQuery, "status" | "checkInStatus">,
    signal?: AbortSignal,
  ) => request<Blob>(
    `/admin/activities/${encodeURIComponent(id)}/registrations/export?${new URLSearchParams({
      status: query.status,
      checkInStatus: query.checkInStatus,
    })}`,
    { signal }, true, "csv",
  ),
  createActivity: (activity: NewActivity) =>
    request<Activity>("/admin/activities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(activity),
    }),
  updateActivity: (id: number, details: ActivityDetails, signal?: AbortSignal) =>
    request<Activity>(`/admin/activities/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: details.title,
        description: details.description,
        location: details.location,
      }),
      signal,
    }),
  cancelActivity: (id: number, reason: string, signal?: AbortSignal) =>
    request<Activity>(`/admin/activities/${id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
      signal,
    }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status >= 500 && error.requestId)
    return `${error.message}（问题编号：${error.requestId}）`;
  return error instanceof Error ? error.message : "操作未完成，请稍后重试。";
}
