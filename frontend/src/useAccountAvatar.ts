import { useLayoutEffect, useRef, useState } from "react";
import { safeAvatarUrl } from "./accountAvatar";
import type { User } from "./types";

interface AvatarSource { source: string; generation: number; url: string; revision: number }

// One authenticated image read supplies both the menu and personal centre.
// Authentication changes revoke the local URL immediately, before a new user is published.
export function useAccountAvatar({ user, generation, revision, read, isCurrent, subscribe }: {
  user: User | null;
  generation: number;
  revision: number;
  read: (url: string, signal: AbortSignal) => Promise<Blob>;
  isCurrent: (generation: number) => boolean;
  subscribe: (listener: () => void) => () => void;
}) {
  const url = safeAvatarUrl(user?.avatarUrl);
  const [image, setImage] = useState<AvatarSource | null>(null);
  const active = useRef<{ controller: AbortController; source: string | null } | null>(null);

  useLayoutEffect(() => subscribe(() => {
    active.current?.controller.abort();
    if (active.current?.source) {
      URL.revokeObjectURL(active.current.source);
      active.current.source = null;
    }
    active.current = null;
    setImage(null);
  }), [subscribe]);

  useLayoutEffect(() => {
    setImage(null);
    if (!user || !url || !isCurrent(generation)) return;
    const lease = { controller: new AbortController(), source: null as string | null };
    active.current = lease;
    const current = () => active.current === lease && !lease.controller.signal.aborted && isCurrent(generation);
    void read(url, lease.controller.signal).then(blob => {
      if (!current()) return;
      lease.source = URL.createObjectURL(blob);
      setImage({ source: lease.source, generation, url, revision });
    }).catch(() => {
      // A missing or unreadable image uses the default avatar. Authentication
      // errors are handled by the guarded read in AuthProvider.
      if (current()) setImage(null);
    });
    return () => {
      lease.controller.abort();
      if (lease.source) {
        URL.revokeObjectURL(lease.source);
        lease.source = null;
      }
      if (active.current === lease) active.current = null;
    };
  }, [user?.id, url, generation, revision, read, isCurrent]);

  return image && image.url === url && image.generation === generation &&
    image.revision === revision && isCurrent(generation) ? image.source : null;
}
