import type { LocationPoint, MapsConfig } from "./types";

export interface ActivityLocationDraft { location: string; locationPoint: LocationPoint | null }

export function validLocationPoint(value: unknown): value is LocationPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as LocationPoint;
  return typeof point.longitude === "number" && Number.isFinite(point.longitude) &&
    point.longitude >= -180 && point.longitude <= 180 &&
    typeof point.latitude === "number" && Number.isFinite(point.latitude) &&
    point.latitude >= -90 && point.latitude <= 90;
}

// Copy only coordinates; SDK objects and unrelated source fields never enter a request.
export function copyLocationPoint(value: unknown): LocationPoint | null {
  return validLocationPoint(value) ? {
    longitude: roundCoordinate(value.longitude), latitude: roundCoordinate(value.latitude),
  } : null;
}

// Match the backend's decimal HALF_UP using the exact JSON number spelling,
// including scientific notation, instead of rounding its binary approximation.
function roundCoordinate(value: number): number {
  const negative = value < 0;
  const [coefficient, exponentText = "0"] = Math.abs(value).toString().split("e");
  const [integer, fraction = ""] = coefficient.split(".");
  const digits = BigInt(integer + fraction);
  const shift = 7 + Number(exponentText) - fraction.length;
  let rounded: bigint;
  if (shift >= 0) rounded = digits * 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    rounded = digits / divisor + (digits % divisor * 2n >= divisor ? 1n : 0n);
  }
  if (rounded === 0n) return 0;
  return Number(negative ? -rounded : rounded) / 10_000_000;
}

export function manualActivityLocation(location: string): ActivityLocationDraft {
  return { location, locationPoint: null };
}

export function selectedActivityLocation(location: string, point: unknown): ActivityLocationDraft {
  const text = location.trim(), locationPoint = copyLocationPoint(point);
  if (!text || text.length > 200 || !locationPoint) throw new Error("请选择有效的位置和不超过 200 个字符的地点。");
  return { location: text, locationPoint };
}

export function amapMarkerUrl(point: unknown, title: string): string | null {
  const position = copyLocationPoint(point);
  if (!position) return null;
  return `https://uri.amap.com/marker?position=${position.longitude},${position.latitude}&name=${encodeURIComponent(title)}&coordinate=gaode&callnative=0`;
}

export function enabledMapsConfig(value: MapsConfig): boolean {
  return value.enabled === true && typeof value.jsKey === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value.jsKey) &&
    value.serviceHost === "/api/_AMapService";
}

// One ticket orders both place searches and reverse geocoding, including failures.
export class MapOperationGate {
  private sequence = 0;
  private active = true;
  private readonly current: () => boolean;
  constructor(current: () => boolean) { this.current = current; }
  begin(): number { return ++this.sequence; }
  isCurrent(ticket: number): boolean { return this.active && ticket === this.sequence && this.current(); }
  dispose(): void { this.active = false; this.sequence++; }
}
