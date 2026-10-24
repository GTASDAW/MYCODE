import { copyLocationPoint, enabledMapsConfig } from "./activityMap.ts";
import type { LocationPoint, MapsConfig } from "./types";

interface AmapLngLat { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number }
interface AmapMap {
  on: (event: "click", handler: (event: { lnglat: AmapLngLat }) => void) => void;
  off: (event: "click", handler: (event: { lnglat: AmapLngLat }) => void) => void;
  setCenter: (point: number[]) => void;
  destroy: () => void;
}
interface AmapMarker { setMap: (map: AmapMap | null) => void; setPosition: (point: number[]) => void }
interface AmapPoi { name?: string; address?: string; pname?: string; cityname?: string; adname?: string; location?: AmapLngLat }
interface PlaceResult { poiList?: { pois?: AmapPoi[] } }
interface GeocodeResult { regeocode?: { formattedAddress?: string } }
export interface AmapSdk {
  Map: new (container: HTMLElement, options: { zoom: number; center?: number[] }) => AmapMap;
  Marker: new (options: { position: number[]; map: AmapMap }) => AmapMarker;
  PlaceSearch: new (options: { pageSize: number; pageIndex: number; extensions: "base" }) => {
    search: (keyword: string, callback: (status: string, result: PlaceResult) => void) => void;
  };
  Geocoder: new () => {
    getAddress: (point: number[], callback: (status: string, result: GeocodeResult) => void) => void;
  };
  plugin: (plugins: string[], ready: () => void) => void;
}

type StartSdk = (config: MapsConfig, ready: (sdk: AmapSdk) => void, failed: () => void) => () => void;
const cancelled = () => new DOMException("Map request cancelled", "AbortError");

// A subscriber can leave without restarting the shared script. A failed load stays
// failed until an explicit user retry; callbacks from a discarded round are ignored.
export function createAmapSdkLoader(start: StartSdk) {
  let round: { identity: string; promise: Promise<AmapSdk>; cleanup: () => void; failed: boolean; reject: (error: Error) => void } | null = null;
  return {
    subscribe(config: MapsConfig, signal: AbortSignal, retry = false): Promise<AmapSdk> {
      if (signal.aborted) return Promise.reject(cancelled());
      if (!enabledMapsConfig(config)) return Promise.reject(new Error("地图暂未配置，仍可手动填写地点并发布。"));
      const identity = `${config.jsKey}:${config.serviceHost}`;
      if (round && (round.identity !== identity || retry && round.failed)) {
        const previous = round; round = null;
        previous.cleanup(); previous.reject(cancelled());
      }
      if (!round) {
        let resolve!: (sdk: AmapSdk) => void, reject!: (error: Error) => void;
        const promise = new Promise<AmapSdk>((done, fail) => { resolve = done; reject = fail; });
        const next = { identity, promise, cleanup: () => {}, failed: false, reject };
        round = next;
        // Keep a rejection observed even if every subscriber has already left.
        void promise.catch(() => {});
        try {
          next.cleanup = start(config,
            sdk => { if (round === next && !next.failed) resolve(sdk); },
            () => {
              if (round !== next || next.failed) return;
              next.failed = true;
              reject(new Error("地图加载失败，请手动重试；仍可手动填写地点。"));
            });
        } catch {
          next.failed = true; reject(new Error("地图加载失败，请手动重试。"));
        }
      }
      const shared = round.promise;
      return new Promise<AmapSdk>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(cancelled()); };
        signal.addEventListener("abort", abort, { once: true });
        shared.then(sdk => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) reject(cancelled()); else resolve(sdk);
        }, error => {
          signal.removeEventListener("abort", abort);
          reject(signal.aborted ? cancelled() : error);
        });
      });
    },
  };
}

// These are the provider's required globals. No authentication or activity state
// is stored on window, and SDK access is confined to this adapter.
function browserSdkStart(config: MapsConfig, ready: (sdk: AmapSdk) => void, failed: () => void): () => void {
  const providerWindow = window as unknown as {
    _AMapSecurityConfig?: { serviceHost: string }; AMap?: AmapSdk;
  };
  providerWindow._AMapSecurityConfig = { serviceHost: `${window.location.origin}/api/_AMapService` };
  const script = document.createElement("script");
  script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.jsKey!)}`;
  script.async = true;
  let active = true;
  const timer = setTimeout(() => { if (active) { active = false; failed(); } }, 20_000);
  const fail = () => {
    if (!active) return;
    active = false; clearTimeout(timer); failed();
  };
  script.onerror = fail;
  script.onload = () => {
    if (!active) return;
    const sdk = providerWindow.AMap;
    if (!sdk) { fail(); return; }
    try {
      sdk.plugin(["AMap.PlaceSearch", "AMap.Geocoder"], () => {
        if (!active) return;
        active = false; clearTimeout(timer); ready(sdk);
      });
    } catch { fail(); }
  };
  document.head.appendChild(script);
  return () => { active = false; clearTimeout(timer); script.onload = null; script.onerror = null; script.remove(); };
}

const sdkLoader = createAmapSdkLoader(browserSdkStart);
export const loadAmapSdk = sdkLoader.subscribe;

function providerPoint(value: AmapLngLat | undefined): LocationPoint | null {
  if (!value) return null;
  return copyLocationPoint({ longitude: value.getLng?.() ?? value.lng, latitude: value.getLat?.() ?? value.lat });
}

export interface MapPlace { location: string; locationPoint: LocationPoint }
export interface ActivityMapHandle {
  setPoint: (point: LocationPoint) => void;
  search: (keyword: string) => Promise<MapPlace[]>;
  reverse: (point: LocationPoint) => Promise<MapPlace>;
  destroy: () => void;
}

export function createActivityMap(sdk: AmapSdk, container: HTMLElement, point: LocationPoint | null,
  onPoint?: (point: LocationPoint) => void): ActivityMapHandle {
  const map = new sdk.Map(container, { zoom: point ? 15 : 5, ...(point ? { center: [point.longitude, point.latitude] } : {}) });
  let marker: AmapMarker | null = null, destroyed = false;
  const removeMarker = () => { marker?.setMap(null); marker = null; };
  const cancellations = new Set<() => void>();
  function operation<T>(start: (resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (destroyed) { reject(cancelled()); return; }
      let finished = false;
      const finish = (value: T | null, error?: Error) => {
        if (finished) return;
        finished = true; clearTimeout(timer); cancellations.delete(abort);
        if (error) reject(error); else resolve(value as T);
      };
      const abort = () => finish(null, cancelled());
      const timer = setTimeout(() => finish(null, new Error("地图请求超时，请手动重试。")), 15_000);
      cancellations.add(abort);
      try { start(value => finish(value), error => finish(null, error)); }
      catch { finish(null, new Error("地图请求失败，请手动重试。")); }
    });
  }
  const setPoint = (position: LocationPoint) => {
    if (destroyed) return;
    const coordinates = [position.longitude, position.latitude];
    if (marker) marker.setPosition(coordinates); else marker = new sdk.Marker({ position: coordinates, map });
    map.setCenter(coordinates);
  };
  const click = (event: { lnglat: AmapLngLat }) => {
    const selected = providerPoint(event.lnglat);
    if (!destroyed && selected) onPoint?.(selected);
  };
  let search: InstanceType<AmapSdk["PlaceSearch"]>, geocoder: InstanceType<AmapSdk["Geocoder"]>;
  try {
    search = new sdk.PlaceSearch({ pageSize: 10, pageIndex: 1, extensions: "base" });
    geocoder = new sdk.Geocoder();
    if (point) setPoint(point);
    if (onPoint) map.on("click", click);
  } catch {
    removeMarker(); map.destroy();
    throw new Error("地图初始化失败，请手动重试。");
  }
  return {
    setPoint,
    search: keyword => operation<MapPlace[]>((resolve, reject) => {
      search.search(keyword, (status, result) => {
        try {
          if (destroyed) { reject(cancelled()); return; }
          if (status === "no_data") { resolve([]); return; }
          const pois = result?.poiList?.pois;
          if (status !== "complete" || !Array.isArray(pois)) throw new Error();
          resolve(pois.map(poi => {
            if (!poi || typeof poi !== "object") throw new Error();
            const locationPoint = providerPoint(poi.location);
            const location = [poi.pname, poi.cityname, poi.adname, poi.address, poi.name].filter(value => typeof value === "string" && value.trim()).join(" ");
            if (!locationPoint || !location) throw new Error();
            return { location, locationPoint };
          }));
        } catch { reject(new Error("地点搜索失败，请手动重试或在地图上选点。")); }
      });
    }),
    reverse: position => operation<MapPlace>((resolve, reject) => {
      geocoder.getAddress([position.longitude, position.latitude], (status, result) => {
        try {
          if (destroyed) { reject(cancelled()); return; }
          const location = result?.regeocode?.formattedAddress;
          if (status !== "complete" || typeof location !== "string" || !location.trim()) throw new Error();
          resolve({ location: location.trim(), locationPoint: { ...position } });
        } catch { reject(new Error("无法获取所选位置地址，请重新选点或搜索地点。")); }
      });
    }),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const abort of [...cancellations]) abort();
      if (onPoint) map.off("click", click);
      removeMarker(); map.destroy();
    },
  };
}
