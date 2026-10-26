import { useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "../api";
import { useAuth } from "../auth";
import { requestNativeLocation } from "../nativeLocation";
import { gcj02UnavailableMessage, locationCheckInUnavailableReason } from "../registrationCheckIn";
import type { LocationCoordinateMode, MyRegistration } from "../types";

export function useLocationCheckIn(scope: string, isCurrentPage: () => boolean, reload: () => void,
  mode: LocationCoordinateMode, gcj02Supported: boolean) {
  const auth = useAuth();
  const ownedScope = useRef<string | null>(scope);
  ownedScope.current = scope;
  const pending = useRef<AbortController | null>(null);
  const writing = useRef(false);
  const liveMode = useRef({ mode, gcj02Supported }); liveMode.current = { mode, gcj02Supported };
  const [state, setState] = useState<{ scope: string; registrationId: number | null; locating: boolean; error: string | null; errorRegistrationId: number | null }>({
    scope, registrationId: null, locating: false, error: null, errorRegistrationId: null,
  });
  useLayoutEffect(() => {
    ownedScope.current = scope;
    writing.current = false;
    // Revisiting a URL scope starts idle after its previous request was aborted.
    setState({ scope, registrationId: null, locating: false, error: null, errorRegistrationId: null });
    const unsubscribe = auth.subscribeAuthentication(() => pending.current?.abort());
    return () => {
      if (ownedScope.current === scope) ownedScope.current = null;
      pending.current?.abort();
      pending.current = null;
      writing.current = false;
      unsubscribe();
    };
  }, [scope, auth.subscribeAuthentication]);
  useLayoutEffect(() => {
    if (mode !== "GCJ02" || gcj02Supported || !pending.current || writing.current) return;
    pending.current.abort(); pending.current = null;
    setState(previous => previous.scope === scope ? { ...previous, registrationId: null, locating: false } : previous);
  }, [mode, gcj02Supported, scope]);

  function cancelForModeChange() {
    if (writing.current) return false;
    pending.current?.abort(); pending.current = null;
    ownedScope.current = null;
    setState({ scope, registrationId: null, locating: false, error: null, errorRegistrationId: null });
    return true;
  }

  async function run(registration: MyRegistration, enabled: boolean) {
    if (pending.current || ownedScope.current !== scope || !isCurrentPage()) return;
    const account = auth.captureAccountRequest();
    if (!account || account.generation !== auth.userGeneration ||
        !auth.isCurrentAuthenticationRequest(auth.userGeneration)) return;
    if (locationCheckInUnavailableReason(registration, enabled, Date.now(), mode, liveMode.current.gcj02Supported)) return;
    const controller = new AbortController();
    pending.current = controller;
    writing.current = false;
    const current = () => pending.current === controller && !controller.signal.aborted &&
      ownedScope.current === scope && liveMode.current.mode === mode && isCurrentPage() && auth.isCurrentAccountRequest(account) &&
      auth.isCurrentAuthenticationRequest(auth.userGeneration);
    setState({ scope, registrationId: registration.id, locating: true, error: null, errorRegistrationId: null });
    let submitted = false;
    try {
      const location = await requestNativeLocation({ signal: controller.signal, isCurrent: current });
      if (!current()) return;
      const unavailable = locationCheckInUnavailableReason(registration, enabled, Date.now(), mode, liveMode.current.gcj02Supported);
      if (unavailable) throw new Error(unavailable);
      setState({ scope, registrationId: registration.id, locating: false, error: null, errorRegistrationId: null });
      submitted = true;
      writing.current = true;
      const body = { ...location, expectedVersion: registration.checkInVersion };
      if (mode === "WGS84") await api.locationCheckIn(registration.id, body, controller.signal);
      else if (mode === "GCJ02") await api.locationCheckInGcj02(registration.id, body, controller.signal);
      else throw new Error("定位坐标模式无效，请重新选择。");
      if (current()) reload();
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 401) auth.expire();
      else {
        const missingCompatibilityRoute = mode === "GCJ02" && error instanceof ApiError && error.status === 404 &&
          error.code !== "REGISTRATION_NOT_FOUND" && error.code !== "ACTIVITY_NOT_FOUND";
        const message = missingCompatibilityRoute ? gcj02UnavailableMessage :
          submitted && (!(error instanceof ApiError) || error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE")
          ? "签到结果未确认，请刷新查看后再决定是否重试。"
          : errorMessage(error);
        setState({ scope, registrationId: registration.id, locating: false, error: message, errorRegistrationId: registration.id });
        if (submitted) reload();
      }
    } finally {
      if (pending.current === controller) {
        const stillCurrent = current();
        pending.current = null;
        writing.current = false;
        if (stillCurrent) setState(previous => previous.scope === scope ? { ...previous, registrationId: null, locating: false } : previous);
      }
    }
  }

  const visible = state.scope === scope ? state : null;
  return { run, busyRegistrationId: visible?.registrationId ?? null,
    cancelForModeChange,
    locating: visible?.locating ?? false, error: visible?.error ?? null,
    errorRegistrationId: visible?.errorRegistrationId ?? null };
}
