import { NotificationRequestOrder } from "./notificationRequestOrder.ts";

interface NotificationRequest<T> {
  signal: AbortSignal;
  isCurrent: () => boolean;
  request: (signal: AbortSignal) => Promise<T>;
  onStart: () => void;
  onSuccess: (result: T) => void;
  onError: (error: unknown) => void;
}

const cancelled = () => new DOMException("Notification request cancelled", "AbortError");

// All badge/list reads share one ordering policy. Scope and identity remain
// owned by their callers, and are checked before every observable effect.
export class NotificationRequests {
  private order = new NotificationRequestOrder();

  async read<T>(options: NotificationRequest<T>): Promise<T> {
    if (options.signal.aborted || !options.isCurrent()) throw cancelled();
    const ticket = this.order.beginRead();
    const current = () => !options.signal.aborted && options.isCurrent() && this.order.isCurrent(ticket);
    if (!current()) throw cancelled();
    options.onStart();
    try {
      const result = await options.request(options.signal);
      if (!current()) throw cancelled();
      options.onSuccess(result);
      return result;
    } catch (error) {
      if (!current()) throw cancelled();
      options.onError(error);
      throw error;
    }
  }

  async write<T>(options: NotificationRequest<T>): Promise<T> {
    const current = () => !options.signal.aborted && options.isCurrent();
    if (!current()) throw cancelled();
    this.order.invalidateReads();
    options.onStart();
    try {
      const result = await options.request(options.signal);
      if (!current()) throw cancelled();
      this.order.invalidateReads();
      options.onSuccess(result);
      return result;
    } catch (error) {
      if (!current()) throw cancelled();
      this.order.invalidateReads();
      options.onError(error);
      throw error;
    }
  }
}
