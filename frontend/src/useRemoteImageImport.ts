import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import { useAuth } from "./auth";
import { fetchRemoteImage, validateRemoteImagePixels } from "./remoteImage";

export function useRemoteImageImport(owner: string, enabled: boolean) {
  const auth = useAuth(), route = useLocation();
  const generation = useSyncExternalStore(auth.subscribeAuthentication,
    auth.captureAuthenticationRequest, auth.captureAuthenticationRequest);
  const scope = `${owner}:${route.pathname}${route.search}${route.hash}:${generation}`;
  const live = useRef({ scope, enabled, auth }); live.current = { scope, enabled, auth };
  const mounted = useRef(false);
  const operation = useRef(0);
  const submission = useRef<AbortController | null>(null);
  const [state, setState] = useState({ scope, url: "", pending: false, error: null as string | null });

  function invalidate() {
    operation.current++;
    submission.current?.abort();
    submission.current = null;
  }
  useLayoutEffect(() => {
    mounted.current = true;
    invalidate();
    setState({ scope, url: "", pending: false, error: null });
    const unsubscribe = auth.subscribeAuthentication(() => {
      invalidate();
      setState({ scope, url: "", pending: false, error: null });
    });
    return () => { mounted.current = false; invalidate(); unsubscribe(); };
  }, [scope, auth.subscribeAuthentication]);
  useLayoutEffect(() => {
    if (!enabled) {
      invalidate();
      setState(previous => previous.scope === scope ? { ...previous, pending: false } : previous);
    }
  }, [enabled, scope]);

  function setUrl(url: string) {
    invalidate();
    setState({ scope, url, pending: false, error: null });
  }
  function cancel(clearUrl = false) {
    invalidate();
    setState(previous => ({ scope, url: clearUrl || previous.scope !== scope ? "" : previous.url, pending: false, error: null }));
  }
  async function importFile(validate: (file: File) => string | null, accept: (file: File) => void) {
    const ticket = auth.captureAccountRequest();
    if (submission.current || !mounted.current || !enabled || live.current.scope !== scope || !ticket ||
        ticket.generation !== auth.userGeneration || !auth.isCurrentAuthenticationRequest(auth.userGeneration) ||
        state.scope !== scope || !state.url.trim()) return;
    const sequence = ++operation.current;
    const controller = new AbortController(); submission.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && submission.current === controller &&
      operation.current === sequence && live.current.scope === scope && live.current.enabled &&
      live.current.auth.userGeneration === ticket.generation && live.current.auth.isCurrentAccountRequest(ticket) &&
      live.current.auth.isCurrentAuthenticationRequest(generation);
    setState(previous => ({ ...previous, pending: true, error: null }));
    try {
      const file = await fetchRemoteImage(state.url, { signal: controller.signal, isCurrent: current });
      if (!current()) return;
      const invalid = validate(file);
      if (invalid) throw new Error(invalid);
      await validateRemoteImagePixels(file, { signal: controller.signal, isCurrent: current });
      if (current()) accept(file);
    } catch (error) {
      if (current()) setState(previous => ({ ...previous, error: error instanceof Error ? error.message :
        "无法直接读取此图片，请先下载到本地后再上传。" }));
    } finally {
      if (submission.current === controller) {
        const stillCurrent = current(); submission.current = null;
        if (stillCurrent) setState(previous => ({ ...previous, pending: false }));
      }
    }
  }
  const visible = state.scope === scope ? state : null;
  return { url: visible?.url ?? "", pending: visible?.pending ?? false, error: visible?.error ?? null,
    setUrl, cancel, importFile, isPending: () => submission.current !== null };
}
