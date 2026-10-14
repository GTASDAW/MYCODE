import { useEffect, useState } from "react";
import { ApiError } from "./api";
import { remainingAuthWait, watchAuthWait } from "./authRateLimit";

interface AuthenticationWait {
  deadline: number;
  generation: number;
}

export function useAuthRateLimit(isCurrent: (generation: number) => boolean) {
  const [wait, setWait] = useState<AuthenticationWait | null>(null);
  const [, setTick] = useState(0);
  const remaining = wait && isCurrent(wait.generation) ? remainingAuthWait(wait.deadline) : 0;

  useEffect(() => {
    if (!wait) return;
    return watchAuthWait(wait.deadline, seconds => {
      if (!isCurrent(wait.generation) || seconds === 0) setWait(null);
      else setTick(tick => tick + 1);
    });
  }, [wait, isCurrent]);

  const acceptRateLimit = (error: unknown, generation: number): boolean => {
    if (!(error instanceof ApiError) || error.retryAfterSeconds === undefined || !isCurrent(generation))
      return false;
    setWait({ generation, deadline: Date.now() + error.retryAfterSeconds * 1000 });
    return true;
  };

  return { remaining, acceptRateLimit };
}
