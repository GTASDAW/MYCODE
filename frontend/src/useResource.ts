import { useCallback, useEffect, useState } from "react";
import type { DependencyList } from "react";

export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loader(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // Dependencies are supplied by each caller to match the values captured by the loader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, revision]);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return { data, setData, loading, error, retry };
}
