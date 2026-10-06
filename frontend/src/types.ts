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
  registrationStatus: "ACTIVE" | "CANCELLED" | null;
  closed: boolean;
}

export interface Registration {
  id: number;
  status: "ACTIVE" | "CANCELLED";
  activity: Activity;
}

export interface NewActivity {
  title: string;
  description: string;
  location: string;
  startsAt: string;
  capacity: number;
}
