export interface User {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: "USER" | "ADMIN";
}

export interface NewUser {
  username: string;
  password: string;
  displayName: string;
}

/** GCJ-02 coordinates supplied by the map provider; never inferred from address text. */
export interface LocationPoint { longitude: number; latitude: number }
export interface MapsConfig { enabled: boolean; jsKey: string | null; serviceHost: string }

export interface Activity {
  id: number;
  title: string;
  description: string;
  location: string;
  locationPoint: LocationPoint | null;
  category: ActivityCategory;
  coverUrl: string | null;
  startsAt: string;
  endsAt?: string | null;
  registrationDeadline?: string | null;
  registrationClosed?: boolean;
  capacity: number;
  registeredCount: number;
  waitingCount: number;
  /** Current user's FIFO position when this projection is WAITING; absent for anonymous/non-waiting views. */
  waitingPosition?: number | null;
  registrationStatus: "ACTIVE" | "WAITING" | "CANCELLED" | null;
  closed: boolean;
  cancelled: boolean;
  cancellationReason: string | null;
  cancelledAt: string | null;
}

export interface Registration {
  id: number;
  status: "ACTIVE" | "WAITING" | "CANCELLED";
  activity: Activity;
}

export interface MyRegistration extends Registration {
  checkedInAt: string | null;
  checkInMethod: CheckInMethod;
  checkInVersion: number;
}

export type CheckInMethod = "ADMIN" | "SELF_LOCATION" | null;
export interface LocationCheckIn {
  /** Native browser coordinates are WGS84; conversion and distance checks belong to the server. */
  longitude: number;
  latitude: number;
  accuracyMeters: number;
  expectedVersion: number;
}

export interface FavoriteState { favorited: boolean; favoritedAt: string | null }
export interface FavoriteQuery { page: number; pageSize: number }
export interface FavoriteItem { activity: Activity; favoritedAt: string }
export type FavoritePage = PageResult<FavoriteItem>;

export interface MyRegistrationQuery {
  keyword?: string;
  page: number;
  pageSize: number;
  status: RegistrationFilter;
}

export interface MyRegistrationPage extends PageResult<MyRegistration> {
  locationCheckInEnabled: boolean;
  summary: {
    activeRegistrations: number;
    waitingRegistrations: number;
    cancelledRegistrations: number;
    checkedInRegistrations: number;
  };
}

export type NotificationFilter = "ALL" | "UNREAD" | "READ";
export type NotificationTypeFilter = "ALL" | "PROMOTED" | "ACTIVITY_CANCELLED";

export interface NotificationQuery {
  page: number;
  pageSize: number;
  status: NotificationFilter;
  type?: NotificationTypeFilter;
}

export interface NotificationReadAllResult { updatedCount: number }

export interface NotificationItem {
  id: number;
  type: "PROMOTED" | "ACTIVITY_CANCELLED";
  activityId: number;
  activityTitle: string;
  cancellationReason: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPage extends PageResult<NotificationItem> {
  unreadCount: number;
}

export interface NewActivity {
  title: string;
  description: string;
  location: string;
  locationPoint?: LocationPoint | null;
  startsAt: string;
  endsAt?: string | null;
  registrationDeadline?: string | null;
  capacity: number;
  category?: ActivityCategory | null;
}

export interface ActivityDetails {
  title: string;
  description: string;
  location: string;
  locationPoint?: LocationPoint | null;
  category?: ActivityCategory | null;
}

export interface AdminOverview {
  totalActivities: number;
  upcomingActivities: number;
  startedActivities: number;
  cancelledActivities: number;
  fullActivities: number;
  activeRegistrations: number;
  waitingRegistrations: number;
  availableSeats: number;
}

export interface AttendanceQuery {
  from: string;
  to: string;
  page: number;
  pageSize: number;
}

export interface AttendanceSummary {
  totalActivities: number;
  activeRegistrations: number;
  checkedInRegistrations: number;
  notCheckedInRegistrations: number;
  checkInRate: number | null;
}

export interface AttendanceActivity {
  id: number;
  title: string;
  location: string;
  startsAt: string;
  capacity: number;
  activeRegistrations: number;
  checkedInRegistrations: number;
  notCheckedInRegistrations: number;
  checkInRate: number | null;
}

export interface AttendancePage extends PageResult<AttendanceActivity> {
  from: string;
  to: string;
  asOf: string;
  summary: AttendanceSummary;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type AuditLogAction = "CREATE" | "EDIT" | "CANCEL" | "CHECK_IN" | "CHECK_IN_REVOKE";
export type AuditLogActionFilter = "ALL" | AuditLogAction;

export interface AdminAuditLogQuery {
  action: AuditLogActionFilter;
  activityId: number | null;
  page: number;
  pageSize: number;
}

export interface AdminAuditLog {
  id: number;
  action: AuditLogAction;
  activityId: number;
  activityTitle: string;
  actorUserId: number;
  actorUsername: string;
  actorDisplayName: string;
  registrationId: number | null;
  targetUsername: string | null;
  targetDisplayName: string | null;
  occurredAt: string;
}

export type AuditLogField = "title" | "description" | "location" | "locationLongitude" | "locationLatitude" | "category" | "coverHash" | "startsAt" | "endsAt" | "registrationDeadline" | "capacity" |
  "cancelledAt" | "cancellationReason" | "checkedInAt" | "checkInMethod" | "checkedInBy" | "checkInReason";

export interface AdminAuditLogDetail extends AdminAuditLog {
  changes: { field: AuditLogField; before: string | null; after: string | null }[];
}

export type ActivityFilter = "ALL" | "OPEN" | "FULL" | "STARTED" | "ONGOING" | "ENDED" | "UPCOMING" | "CANCELLED";
export type ActivityCategory = "UNCATEGORIZED" | "TECHNOLOGY" | "SPORTS" | "CULTURE" | "OTHER";
export type ActivityCategoryFilter = "ALL" | ActivityCategory;
export type RegistrationFilter = "ALL" | "ACTIVE" | "WAITING" | "CANCELLED";
export type CheckInFilter = "ALL" | "CHECKED_IN" | "NOT_CHECKED_IN";

export interface AdminActivityQuery {
  page: number;
  pageSize: number;
  keyword: string;
  status: ActivityFilter;
  category: ActivityCategoryFilter;
  startDateFrom?: string;
  startDateTo?: string;
}

export type ActivitySearchQuery = AdminActivityQuery;

export interface ActivitySearchPage extends PageResult<Activity> {
  summary: {
    upcomingActivities: number;
    availableSeats: number;
  };
}

export interface AdminRegistrationQuery {
  page: number;
  pageSize: number;
  status: RegistrationFilter;
  checkInStatus: CheckInFilter;
  keyword: string;
}

export interface AdminRegistration {
  id: number;
  userId: number;
  username: string;
  displayName: string;
  status: "ACTIVE" | "WAITING" | "CANCELLED";
  createdAt: string;
  updatedAt: string;
  checkedInAt: string | null;
  checkInMethod: CheckInMethod;
  checkInVersion: number;
  checkedInBy: number | null;
  checkedInByDisplayName: string | null;
}

export interface AdminRegistrationPage extends PageResult<AdminRegistration> {
  activity: Activity;
  summary: {
    activeRegistrations: number;
    checkedInRegistrations: number;
    notCheckedInRegistrations: number;
  };
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
