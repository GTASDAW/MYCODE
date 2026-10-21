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
  NotificationReadAllResult,
  AdminAuditLog,
  AdminAuditLogDetail,
  AdminAuditLogQuery,
  AttendancePage,
  AttendanceQuery,
  FavoriteState,
  FavoritePage,
  FavoriteQuery,
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
interface PendingCsrf {
  version: number;
  controller: AbortController;
  subscribers: Set<symbol>;
  finished: boolean;
  promise: Promise<CsrfToken>;
}
let csrfPromise: PendingCsrf | null = null;

function beginCsrfTransition(): number {
  // The cached token can still authorize the login/logout POST. Any pending
  // refresh belongs to the preceding transition and must not supply its token.
  csrfPromise?.controller.abort();
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
    const token = csrf ?? (await getCsrf(options.signal ?? undefined));
    headers.set(token.headerName, token.token);
  }
  options.signal?.throwIfAborted();
  const dispatchedCsrfVersion = csrfVersion;

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
      if (dispatchedCsrfVersion !== csrfVersion)
        throw new DOMException("CSRF recovery authentication changed", "AbortError");
      await refreshCsrf(options.signal ?? undefined);
      if (dispatchedCsrfVersion !== csrfVersion)
        throw new DOMException("CSRF recovery authentication changed", "AbortError");
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

function subscribeCsrf(pending: PendingCsrf, signal?: AbortSignal): Promise<CsrfToken> {
  signal?.throwIfAborted();
  const cancelled = () => new DOMException("CSRF subscription cancelled", "AbortError");
  if (pending.controller.signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const subscriber = Symbol();
    let settled = false;
    pending.subscribers.add(subscriber);
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      pending.controller.signal.removeEventListener("abort", abort);
      pending.subscribers.delete(subscriber);
      // One departing page must not abort another live subscriber. Once no
      // caller remains, stop the network read as well as ignoring its token.
      if (!pending.finished && pending.subscribers.size === 0) pending.controller.abort();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cancelled());
    };
    signal?.addEventListener("abort", abort, { once: true });
    pending.controller.signal.addEventListener("abort", abort, { once: true });
    pending.promise.then(token => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(token);
    }, error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

async function getCsrf(signal?: AbortSignal, owned = false): Promise<CsrfToken> {
  signal?.throwIfAborted();
  if (csrf) return csrf;
  if (csrfPromise && (csrfPromise.controller.signal.aborted || csrfPromise.version !== csrfVersion))
    beginCsrfTransition();
  if (!csrfPromise) {
    const version = csrfVersion;
    const controller = new AbortController();
    // A new-session refresh belongs to the authentication that requested it.
    // Ordinary initialization/recovery instead uses subscriber cancellation.
    const cancelOwner = () => controller.abort();
    if (owned) signal?.addEventListener("abort", cancelOwner, { once: true });
    const isCurrent = () => !controller.signal.aborted && version === csrfVersion;
    const cancelled = () => new DOMException("CSRF refresh cancelled", "AbortError");
    const pending: PendingCsrf = { version, controller, subscribers: new Set(), finished: false,
      promise: request<CsrfToken>("/auth/csrf", { signal: controller.signal })
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
        pending.finished = true;
        if (owned) signal?.removeEventListener("abort", cancelOwner);
        // A stale refresh must not erase a newer refresh's shared promise.
        if (csrfPromise === pending) csrfPromise = null;
      }),
    };
    csrfPromise = pending;
  }
  return subscribeCsrf(csrfPromise, signal);
}

async function refreshCsrf(signal?: AbortSignal, newSession = false): Promise<void> {
  signal?.throwIfAborted();
  csrf = null;
  if (newSession) beginCsrfTransition();
  await getCsrf(signal, newSession);
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
  changePassword: async (currentPassword: string, newPassword: string, signal?: AbortSignal) => {
    const result = await request<{ success: boolean }>("/me/password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }), signal,
    });
    if (result?.success !== true)
      throw new ApiError(200, "结果未确认，请重新登录确认。", "INVALID_RESPONSE");
  },
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
  logout: async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const version = beginCsrfTransition();
    await request("/auth/logout", { method: "POST", signal });
    signal?.throwIfAborted();
    if (version !== csrfVersion)
      throw new DOMException("Logout refresh superseded", "AbortError");
    await refreshCsrf(signal, true);
  },
  activities: (signal?: AbortSignal) =>
    request<Activity[]>("/activities", { signal }),
  searchActivities: (query: ActivitySearchQuery, signal?: AbortSignal) =>
    request<ActivitySearchPage>(
      `/activities/search?${new URLSearchParams({
        keyword: query.keyword,
        status: query.status,
        category: query.category ?? "ALL",
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
  favorite: (id: number, signal?: AbortSignal) =>
    request<FavoriteState>(`/me/favorites/${id}`, { signal }),
  setFavorite: (id: number, favorited: boolean, signal?: AbortSignal) =>
    request<FavoriteState>(`/me/favorites/${id}`, { method: favorited ? "POST" : "DELETE", signal }),
  favorites: (query: FavoriteQuery, signal?: AbortSignal) =>
    request<FavoritePage>(`/me/favorites?${new URLSearchParams({page: String(query.page), pageSize: String(query.pageSize)})}`, {signal}),
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
        type: query.type ?? "ALL",
      })}`,
      { signal },
    ),
  notificationUnreadCount: (signal?: AbortSignal) =>
    request<{ unreadCount: number }>("/me/notifications/unread-count", { signal }),
  readNotification: (id: number, signal?: AbortSignal) =>
    request<NotificationItem>(`/me/notifications/${id}/read`, { method: "POST", signal }),
  readAllNotifications: (signal?: AbortSignal) =>
    request<NotificationReadAllResult>("/me/notifications/read-all", { method: "POST", signal }),
  adminOverview: (signal?: AbortSignal) =>
    request<AdminOverview>("/admin/overview", { signal }),
  adminAttendance: (query: AttendanceQuery, signal?: AbortSignal) =>
    request<AttendancePage>(`/admin/attendance?${new URLSearchParams({
      from: query.from, to: query.to, page: String(query.page), pageSize: String(query.pageSize),
    })}`, { signal }),
  adminMonitoring: (signal?: AbortSignal) =>
    request<AdminMonitoring>("/admin/monitoring", { signal }),
  adminAuditLogs: (query: AdminAuditLogQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams({
      page: String(query.page), pageSize: String(query.pageSize), action: query.action,
    });
    if (query.activityId !== null && query.activityId !== undefined)
      params.set("activityId", String(query.activityId));
    return request<PageResult<AdminAuditLog>>(`/admin/audit-logs?${params}`, { signal });
  },
  adminAuditLog: (id: number, signal?: AbortSignal) =>
    request<AdminAuditLogDetail>(`/admin/audit-logs/${encodeURIComponent(id)}`, { signal }),
  adminActivities: (query: AdminActivityQuery, signal?: AbortSignal) =>
    request<PageResult<Activity>>(
      `/admin/activities?${new URLSearchParams({
        page: String(query.page),
        pageSize: String(query.pageSize),
        keyword: query.keyword,
        status: query.status,
        category: query.category ?? "ALL",
      })}`,
      { signal },
    ),
  adminRegistrations: (
    id: string,
    query: Omit<AdminRegistrationQuery, "keyword"> & { keyword?: string },
    signal?: AbortSignal,
  ) =>
    request<AdminRegistrationPage>(
      `/admin/activities/${encodeURIComponent(id)}/registrations?${new URLSearchParams(
        {
          page: String(query.page),
          pageSize: String(query.pageSize),
          status: query.status,
          checkInStatus: query.checkInStatus,
          keyword: query.keyword ?? "",
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
    query: Pick<AdminRegistrationQuery, "status" | "checkInStatus"> & { keyword?: string },
    signal?: AbortSignal,
  ) => request<Blob>(
    `/admin/activities/${encodeURIComponent(id)}/registrations/export?${new URLSearchParams({
      status: query.status,
      checkInStatus: query.checkInStatus,
      keyword: query.keyword ?? "",
    })}`,
    { signal }, true, "csv",
  ),
  createActivity: (activity: NewActivity, signal?: AbortSignal) =>
    request<Activity>("/admin/activities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(activity),
      signal,
    }),
  updateActivity: (id: number, details: ActivityDetails, signal?: AbortSignal) =>
    request<Activity>(`/admin/activities/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: details.title,
        description: details.description,
        location: details.location,
        category: details.category,
      }),
      signal,
    }),
  uploadActivityCover: (id: number, file: File, signal?: AbortSignal) => {
    const body = new FormData(); body.append("file", file);
    return request<Activity>(`/admin/activities/${id}/cover`, { method: "POST", body, signal });
  },
  removeActivityCover: (id: number, signal?: AbortSignal) =>
    request<Activity>(`/admin/activities/${id}/cover`, { method: "DELETE", signal }),
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
