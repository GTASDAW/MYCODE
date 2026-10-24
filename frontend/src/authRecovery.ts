import { ApiError } from "./api.ts";
import type { User } from "./types";

// A failed logout can mean either a rejected POST or a completed POST whose
// response/CSRF refresh was lost. Confirm the Session with reads only.
export async function confirmLogoutSession({ signal, isCurrent, readSession, refreshCsrf }: {
  signal: AbortSignal;
  isCurrent: () => boolean;
  readSession: (signal: AbortSignal) => Promise<User>;
  refreshCsrf: (signal: AbortSignal) => Promise<void>;
}): Promise<{ user: User | null; csrfReady: boolean }> {
  const check = () => {
    if (signal.aborted || !isCurrent()) throw new DOMException("Logout recovery cancelled", "AbortError");
  };
  check();
  let user: User | null;
  try {
    user = await readSession(signal);
    check();
  } catch (error) {
    check();
    if (!(error instanceof ApiError && error.status === 401)) throw error;
    user = null;
  }
  let csrfReady = true;
  try {
    await refreshCsrf(signal);
    check();
  } catch {
    check();
    csrfReady = false;
  }
  return { user, csrfReady };
}
