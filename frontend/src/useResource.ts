import { useCallback, useEffect, useState } from "react";
import type { DependencyList, SetStateAction } from "react";

interface ResourceState<T> {
  dependencies: DependencyList;
  revision: number;
  data: T | null;
  loading: boolean;
  error: unknown;
}

export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ResourceState<T>>({
    dependencies: [...deps],
    revision: 0,
    data: null,
    loading: true,
    error: null,
  });
  const matches = (value: ResourceState<T>) =>
    value.revision === revision &&
    value.dependencies.length === deps.length &&
    value.dependencies.every((dependency, index) =>
      Object.is(dependency, deps[index]),
    );

  useEffect(() => {
    const controller = new AbortController();
    const dependencies = [...deps];
    setState({
      dependencies,
      revision,
      data: null,
      loading: true,
      error: null,
    });
    loader(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setState({
            dependencies,
            revision,
            data,
            loading: false,
            error: null,
          });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({
            dependencies,
            revision,
            data: null,
            loading: false,
            error,
          });
      });
    return () => controller.abort();
    // Each page supplies all values captured by its loader as dependencies.
  }, [...deps, revision]);

  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const setData = (update: SetStateAction<T | null>) =>
    setState((previous) => {
      if (!matches(previous)) return previous;
      return {
        ...previous,
        data:
          typeof update === "function"
            ? (update as (value: T | null) => T | null)(previous.data)
            : update,
      };
    });
  const current = matches(state);
  return {
    data: current ? state.data : null,
    setData,
    loading: !current || state.loading,
    error: current ? state.error : null,
    retry,
  };
}
