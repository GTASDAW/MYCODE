import { useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "../api";
import { useAuth } from "../auth";
import { requestNativeLocation } from "../nativeLocation";
import { locationCheckInUnavailableReason } from "../registrationCheckIn";
import type { MyRegistration } from "../types";

export function useLocationCheckIn(scope: string, isCurrentPage: () => boolean, reload: () => void) {
  const auth = useAuth();
  const ownedScope = useRef<string | null>(scope);
  ownedScope.current = scope;
  const pending = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ scope: string; registrationId: number | null; locating: boolean; error: string | null }>({
    scope, registrationId: null, locating: false, error: null,
  });
  useLayoutEffect(() => {
    ownedScope.current = scope;
    const unsubscribe = auth.subscribeAuthentication(() => pending.current?.abort());
    return () => {
      if (ownedScope.current === scope) ownedScope.current = null;
      pending.current?.abort();
      pending.current = null;
      unsubscribe();
    };
  }, [scope, auth.subscribeAuthentication]);

  async function run(registration: MyRegistration, enabled: boolean) {
    if (pending.current || ownedScope.current !== scope || !isCurrentPage()) return;
    const account = auth.captureAccountRequest();
    if (!account || account.generation !== auth.userGeneration ||
        !auth.isCurrentAuthenticationRequest(auth.userGeneration)) return;
    if (locationCheckInUnavailableReason(registration, enabled)) return;
    const controller = new AbortController();
    pending.current = controller;
    const current = () => pending.current === controller && !controller.signal.aborted &&
      ownedScope.current === scope && isCurrentPage() && auth.isCurrentAccountRequest(account) &&
      auth.isCurrentAuthenticationRequest(auth.userGeneration);
    setState({ scope, registrationId: registration.id, locating: true, error: null });
    let submitted = false;
    try {
      const location = await requestNativeLocation({ signal: controller.signal, isCurrent: current });
      if (!current()) return;
      const unavailable = locationCheckInUnavailableReason(registration, enabled);
      if (unavailable) throw new Error(unavailable);
      setState({ scope, registrationId: registration.id, locating: false, error: null });
      submitted = true;
      await api.locationCheckIn(registration.id, { ...location, expectedVersion: registration.checkInVersion }, controller.signal);
      if (current()) reload();
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 401) auth.expire();
      else {
        const message = submitted && (!(error instanceof ApiError) || error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE")
          ? "签到结果未确认，请刷新查看后再决定是否重试。"
          : errorMessage(error);
        setState({ scope, registrationId: registration.id, locating: false, error: message });
        if (submitted) reload();
      }
    } finally {
      if (pending.current === controller) {
        const stillCurrent = current();
        pending.current = null;
        if (stillCurrent) setState(previous => previous.scope === scope ? { ...previous, registrationId: null, locating: false } : previous);
      }
    }
  }

  const visible = state.scope === scope ? state : null;
  return { run, busyRegistrationId: visible?.registrationId ?? null,
    locating: visible?.locating ?? false, error: visible?.error ?? null };
}
