export interface NativeLocation {
  longitude: number;
  latitude: number;
  accuracyMeters: number;
}

interface NativeLocationOptions {
  signal: AbortSignal;
  isCurrent: () => boolean;
  secureContext?: boolean;
  geolocation?: Pick<Geolocation, "getCurrentPosition">;
}

// A native request cannot be stopped. Abort settles our promise and every late
// callback checks ownership before exposing coordinates to its caller.
export function requestNativeLocation(options: NativeLocationOptions): Promise<NativeLocation> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancelled = () => new DOMException("Location request cancelled", "AbortError");
    const finish = (error?: Error, location?: NativeLocation) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(location!);
    };
    const current = () => !options.signal.aborted && options.isCurrent();
    const abort = () => finish(cancelled());
    if (!current()) { abort(); return; }
    if (!(options.secureContext ?? globalThis.isSecureContext)) {
      finish(new Error("当前页面无法安全获取定位，请通过安全连接打开，或联系管理员确认到场。"));
      return;
    }
    const geolocation = options.geolocation ?? globalThis.navigator?.geolocation;
    if (!geolocation) { finish(new Error("当前浏览器不支持定位，请更换浏览器或联系管理员确认到场。")); return; }
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      geolocation.getCurrentPosition(position => {
        if (!current()) { abort(); return; }
        const { longitude, latitude, accuracy } = position.coords;
        if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
            !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
          finish(new Error("未获得有效位置，请手动重试或联系管理员确认到场。"));
          return;
        }
        if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 100) {
          finish(new Error("定位精度不足，请到室外或开阔处手动重试，或联系管理员确认到场。"));
          return;
        }
        finish(undefined, { longitude, latitude, accuracyMeters: accuracy });
      }, error => {
        if (!current()) { abort(); return; }
        finish(new Error(error.code === 1
          ? "定位权限未开启，请在浏览器中允许定位后手动重试，或联系管理员确认到场。"
          : error.code === 3
            ? "定位超时，请手动重试或联系管理员确认到场。"
            : "暂时无法获取位置，请手动重试或联系管理员确认到场。"));
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 });
    } catch {
      if (!current()) abort();
      else finish(new Error("暂时无法获取位置，请手动重试或联系管理员确认到场。"));
    }
  });
}
