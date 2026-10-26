export const remoteImageMaxBytes = 2 * 1024 * 1024;

const urlError = "请输入不含身份信息或片段的公开 HTTPS 图片链接。";
const fetchError = "无法直接读取此图片，请先下载到本地后再上传。";
const decodeError = "无法解码这张图片，请先下载到本地后重新选择 PNG 或 JPEG 图片。";
const imageTimeoutMs = 10_000;

type RemoteImageOptions = { signal: AbortSignal; isCurrent?: () => boolean };

function isPublicIpv4(host: string): boolean {
  const [a, b, c] = host.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
    a === 192 && (b === 0 && (c === 0 || c === 2) || b === 168) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
    a === 203 && b === 0 && c === 113);
}

function isPublicIpv6(host: string): boolean {
  const halves = host.slice(1, -1).split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    .map(word => Number.parseInt(word, 16));
  // Only global unicast literals are accepted. This also excludes IPv4 mapped,
  // compatible, NAT64, loopback, link-local, unique-local and multicast addresses.
  return words[0] >= 0x2000 && words[0] <= 0x3fff && words[0] !== 0x2002 &&
    !(words[0] === 0x2001 && (words[1] === 0 || words[1] === 0x0db8));
}

export function normalizeRemoteImageUrl(raw: string): string {
  try {
    const value = raw.trim();
    if (!/^https:\/\//i.test(value) || /[\\#\u0000-\u0020\u007f]/.test(value)) throw new Error();
    const authority = value.slice(value.indexOf("://") + 3).split(/[/?]/, 1)[0];
    if (!authority || authority.includes("@")) throw new Error();
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (url.protocol !== "https:" || url.username || url.password || !host ||
      host === "localhost" || host.endsWith(".localhost") || host === "local" || host.endsWith(".local") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) && !isPublicIpv4(host) ||
      host.startsWith("[") && !isPublicIpv6(host)) throw new Error();
    return url.href;
  } catch {
    throw new Error(urlError);
  }
}

const cancelled = () => new DOMException("图片读取已取消。", "AbortError");

function imageScope(options: RemoteImageOptions, failureMessage: string) {
  const controller = new AbortController();
  let stopped = false;
  let disposed = false;
  let wasCancelled = false;
  let rejectStopped: (error: Error) => void = () => {};
  const stoppedPromise = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const isCurrent = () => !wasCancelled && !options.signal.aborted && (options.isCurrent?.() ?? true);
  const assertCurrent = () => {
    if (!isCurrent()) {
      wasCancelled = true;
      throw cancelled();
    }
  };
  const stop = () => {
    if (stopped || disposed) return;
    stopped = true;
    wasCancelled = !isCurrent();
    controller.abort();
    rejectStopped(wasCancelled ? cancelled() : new Error(failureMessage));
  };
  options.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, imageTimeoutMs);
  return {
    signal: controller.signal,
    assertCurrent,
    active: () => !stopped && !disposed && isCurrent(),
    async wait<T>(pending: Promise<T>): Promise<T> {
      const value = await Promise.race([pending, stoppedPromise]);
      assertCurrent();
      return value;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", stop);
      controller.abort();
    },
  };
}

function discardBody(response: Response) {
  try { void response.body?.cancel().catch(() => {}); } catch { /* Best-effort release of a late body. */ }
}

export async function fetchRemoteImage(raw: string, options: RemoteImageOptions): Promise<File> {
  if (options.signal.aborted || options.isCurrent?.() === false) throw cancelled();
  const url = normalizeRemoteImageUrl(raw);
  const scope = imageScope(options, fetchError);
  const invalidSize = new Error("链接返回的图片应大于 0 且不超过 2 MB。");
  const invalidType = new Error("链接必须直接返回 PNG 或 JPEG 图片。");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    scope.assertCurrent();
    const response = await scope.wait(fetch(url, {
      method: "GET", mode: "cors", credentials: "omit", referrerPolicy: "no-referrer",
      cache: "no-store", redirect: "error", signal: scope.signal,
    }).then(result => {
      if (!scope.active()) discardBody(result);
      return result;
    }));
    if (response.status < 200 || response.status >= 300 || response.redirected ||
      response.type === "opaque" || response.type === "opaqueredirect") {
      discardBody(response);
      throw new Error(fetchError);
    }
    const type = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
    if (type !== "image/png" && type !== "image/jpeg") {
      discardBody(response);
      throw invalidType;
    }
    if (!response.body) throw invalidSize;
    reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    while (true) {
      const chunk = await scope.wait(reader.read());
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > remoteImageMaxBytes) throw invalidSize;
      // Copy stream-owned views so a producer cannot mutate already accepted data.
      chunks.push(new Uint8Array(chunk.value));
    }
    if (size === 0) throw invalidSize;
    scope.assertCurrent();
    return new File(chunks, type === "image/png" ? "remote-image.png" : "remote-image.jpg", { type });
  } catch (error) {
    scope.assertCurrent();
    if (error === invalidSize || error === invalidType) throw error;
    throw new Error(fetchError);
  } finally {
    scope.dispose();
    if (reader) {
      try { void reader.cancel().catch(() => {}); } catch { /* A stalled reader must not delay cleanup. */ }
      try { reader.releaseLock(); } catch { /* A pending read can retain its lock until cancellation settles. */ }
    }
  }
}

export async function validateRemoteImagePixels(file: File, options: RemoteImageOptions): Promise<void> {
  if (options.signal.aborted || options.isCurrent?.() === false) throw cancelled();
  const scope = imageScope(options, decodeError);
  const invalidSize = new Error("图片宽高不能超过 4096 像素，且总像素不能超过 1600 万。");
  let objectUrl: string | undefined;
  let image: HTMLImageElement | undefined;
  try {
    scope.assertCurrent();
    objectUrl = URL.createObjectURL(file);
    image = new Image();
    const target = image;
    await scope.wait(new Promise<void>((resolve, reject) => {
      target.onload = () => resolve();
      target.onerror = () => reject(new Error(decodeError));
      target.src = objectUrl!;
    }));
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 16_000_000))
      throw invalidSize;
    scope.assertCurrent();
  } catch (error) {
    scope.assertCurrent();
    if (error === invalidSize) throw error;
    throw new Error(decodeError);
  } finally {
    scope.dispose();
    if (image) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
