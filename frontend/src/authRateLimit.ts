export function remainingAuthWait(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

// This only updates local feedback. It never requests the server or submits a
// form. Recalculate from the deadline after delayed/background timer callbacks.
export function watchAuthWait(deadline: number, onTick: (remaining: number) => void): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (!active) return;
    const remaining = remainingAuthWait(deadline);
    onTick(remaining);
    if (remaining > 0) timer = setTimeout(tick, Math.min(1000, Math.max(1, deadline - Date.now())));
  };
  tick();
  return () => {
    active = false;
    clearTimeout(timer);
  };
}
