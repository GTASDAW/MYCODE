import { useEffect, useState } from "react";
import { nextActivityBoundary } from "./activityLifecycle";
import type { Activity } from "./types";

// One timer per visible page, shared by all its cards, statuses and controls.
// These local updates never issue a request or change the submitted query.
export function useActivityClock(activities: readonly (Activity | undefined)[]): number {
  const [now, setNow] = useState(Date.now);
  const times = JSON.stringify(activities.filter(activity => activity && !activity.cancelled)
    .map(activity => ({ startsAt: activity!.startsAt, endsAt: activity!.endsAt, cancelled: false })));
  useEffect(() => {
    const boundaries = JSON.parse(times) as Activity[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    function update() {
      if (!active) return;
      if (timer !== undefined) clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      const next = nextActivityBoundary(boundaries, current);
      // Recheck long waits for local clock changes; background tabs also catch up on focus.
      if (next !== null) timer = setTimeout(update, Math.min(60_000, Math.max(1, next - current)));
    }
    update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [times]);
  return now;
}
