export interface User {
  id: number;
  username: string;
  displayName: string;
  role: "USER" | "ADMIN";
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
