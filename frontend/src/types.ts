export interface User {
  id: number;
  username: string;
  displayName: string;
  role: "USER" | "ADMIN";
}

export interface NewUser {
  username: string;
  password: string;
  displayName: string;
}

export interface Activity {
  id: number;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  capacity: number;
  registeredCount: number;
  waitingCount: number;
  registrationStatus: "ACTIVE" | "WAITING" | "CANCELLED" | null;
  closed: boolean;
}

export interface Registration {
  id: number;
  status: "ACTIVE" | "WAITING" | "CANCELLED";
  activity: Activity;
}

export interface NewActivity {
  title: string;
  description: string;
  location: string;
  startsAt: string;
  capacity: number;
}

export interface AdminOverview {
  totalActivities: number;
  upcomingActivities: number;
  startedActivities: number;
  fullActivities: number;
  activeRegistrations: number;
  waitingRegistrations: number;
  availableSeats: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type ActivityFilter = "ALL" | "OPEN" | "FULL" | "STARTED" | "UPCOMING";
export type RegistrationFilter = "ALL" | "ACTIVE" | "WAITING" | "CANCELLED";

export interface AdminActivityQuery {
  page: number;
  pageSize: number;
  keyword: string;
  status: ActivityFilter;
}

export interface AdminRegistrationQuery {
  page: number;
  pageSize: number;
  status: RegistrationFilter;
}

export interface AdminRegistration {
  id: number;
  userId: number;
  username: string;
  displayName: string;
  status: "ACTIVE" | "WAITING" | "CANCELLED";
  createdAt: string;
  updatedAt: string;
}

export interface AdminRegistrationPage extends PageResult<AdminRegistration> {
  activity: Activity;
}

export interface DurationMetrics {
  count: number;
  averageDurationMs: number;
  maxDurationMs: number | null;
  p95DurationMs: number | null;
}

export interface RouteMetrics extends DurationMetrics {
  method: string;
  route: string;
  status: number;
}

export interface AdminMonitoring {
  instanceId: string;
  startedAt: string;
  sampledAt: string;
  scope: string;
  totalRequests: number;
  clientErrors: number;
  serverErrors: number;
  serverErrorRate: number;
  averageDurationMs: number;
  latencyWindowSeconds: number;
  routes: RouteMetrics[];
  registrationLock: DurationMetrics;
  databasePool: {
    active: number | null;
    idle: number | null;
    pending: number | null;
    max: number | null;
  };
}
