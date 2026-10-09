import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError, errorMessage } from "../api";
import { useAuth } from "../auth";
import type { Activity } from "../types";

// A page owns one submission. Both successful and failed responses must still
// belong to its mounted page and the authentication that started the request.
export function useActivityMutation() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const submission = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      submission.current?.abort();
    };
  }, [pathname]);

  async function run(
    request: (signal: AbortSignal) => Promise<Activity>,
    onSuccess: (activity: Activity) => void,
  ) {
    if (submission.current) return;
    const account = auth.captureAccountRequest();
    if (!account) return;
    const controller = new AbortController();
    submission.current = controller;
    setBusy(true);
    setError(null);
    const current = () => mounted.current && !controller.signal.aborted &&
      auth.isCurrentAccountRequest(account);
    try {
      const activity = await request(controller.signal);
      if (current()) onSuccess(activity);
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && err.status === 401) {
        auth.expire();
        navigate("/login", {
          state: { from: pathname, notice: "登录已过期，请重新登录后继续。" },
        });
      } else setError(errorMessage(err));
    } finally {
      if (submission.current === controller) {
        submission.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }

  return { busy, error, clearError: () => setError(null), run };
}
