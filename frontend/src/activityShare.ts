export function buildActivityShareUrl(activityId: number, origin: string): string {
  try {
    if (!Number.isSafeInteger(activityId) || activityId < 1) throw new Error();
    const site = new URL(origin);
    if (!["http:", "https:"].includes(site.protocol) || site.username || site.password) throw new Error();
    return new URL(`/activities/${activityId}`, site.origin).href;
  } catch {
    throw new Error("活动链接不正确，请刷新详情后重试。");
  }
}

interface ShareCopyRequest {
  url: string;
  isCurrent: () => boolean;
  write: (url: string) => Promise<void>;
  onStart: () => void;
  onSuccess: () => void;
  onFallback: () => void;
  onFinish: () => void;
}

// The caller owns page/authentication scope; this only owns clipboard operation order.
export class ActivityShareRequests {
  private active: object | null = null;

  invalidate() { this.active = null; }

  async copy(options: ShareCopyRequest): Promise<void> {
    if (this.active || !options.isCurrent()) return;
    const ticket = {};
    this.active = ticket;
    const current = () => this.active === ticket && options.isCurrent();
    try {
      options.onStart();
      if (!current()) return;
      // Keep the native clipboard call inside the original click, before any await.
      await options.write(options.url);
      if (current()) options.onSuccess();
    } catch {
      if (current()) options.onFallback();
    } finally {
      const accepted = current();
      if (this.active === ticket) this.active = null;
      if (accepted) options.onFinish();
    }
  }
}
