export interface AccountRequest {
  generation: number;
  userId: number;
}

// A read owns its AbortSignal and account ticket. Check both before reporting
// success or errors, so an old 401 cannot expire a newer authentication.
export async function readAccountResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  isCurrent: () => boolean,
  onCurrentError: (error: unknown) => void,
): Promise<T> {
  const current = () => !signal.aborted && isCurrent();
  const cancelled = () => new DOMException("Account request cancelled", "AbortError");
  if (!current()) throw cancelled();
  try {
    const data = await loader(signal);
    if (!current()) throw cancelled();
    return data;
  } catch (error) {
    if (!current()) throw cancelled();
    onCurrentError(error);
    throw error;
  }
}

interface ProfileRead extends AccountRequest {
  version: number;
  sequence: number;
}

interface ProfileWrite extends AccountRequest {
  sequence: number;
}

// Owns request ordering only; the authenticated user stays in AuthProvider.
export class AuthRequestGuard {
  private generation = 0;
  private profileVersion = 0;
  private reads = 0;
  private writes = 0;
  private avatarVersion = 0;
  private avatarReads = 0;
  private avatarWrites = 0;
  private avatarListeners = new Set<() => void>();
  private authenticationListeners = new Set<() => void>();

  beginAuthentication(): number {
    this.profileVersion++;
    const generation = ++this.generation;
    for (const listener of [...this.authenticationListeners]) {
      if (this.authenticationListeners.has(listener)) listener();
    }
    return generation;
  }

  captureAuthentication(): number {
    return this.generation;
  }

  subscribeAuthentication(listener: () => void): () => void {
    const subscription = () => listener();
    this.authenticationListeners.add(subscription);
    return () => { this.authenticationListeners.delete(subscription); };
  }

  isCurrentAuthentication(generation: number): boolean {
    return this.generation === generation;
  }

  beginAccountRequest(userId: number): AccountRequest {
    return { generation: this.generation, userId };
  }

  beginProfileRead(userId: number): ProfileRead {
    return {
      generation: this.generation,
      userId,
      version: this.profileVersion,
      sequence: ++this.reads,
    };
  }

  beginProfileWrite(userId: number): ProfileWrite {
    this.profileVersion++;
    return { generation: this.generation, userId, sequence: ++this.writes };
  }

  isSameAccount(request: AccountRequest, userId: number | undefined): boolean {
    return this.generation === request.generation && request.userId === userId;
  }

  isCurrentProfileRead(request: ProfileRead, userId: number | undefined): boolean {
    return (
      this.isSameAccount(request, userId) &&
      request.version === this.profileVersion &&
      request.sequence === this.reads
    );
  }

  finishProfileWrite(request: ProfileWrite, userId: number | undefined): boolean {
    if (!this.isCurrentProfileWrite(request, userId)) return false;
    // A read started while the save was in flight may contain the old nickname.
    this.profileVersion++;
    return true;
  }

  isCurrentProfileWrite(request: ProfileWrite, userId: number | undefined): boolean {
    return this.isSameAccount(request, userId) && request.sequence === this.writes;
  }

  captureAvatarVersion(): number {
    return this.avatarVersion;
  }

  subscribeAvatarRevision(listener: () => void): () => void {
    this.avatarListeners.add(listener);
    return () => { this.avatarListeners.delete(listener); };
  }

  publishAvatarRevision(request: ProfileWrite, userId: number | undefined): void {
    if (!this.isCurrentAvatarWrite(request, userId)) return;
    this.avatarVersion++;
    for (const listener of [...this.avatarListeners]) listener();
  }

  beginAvatarRead(userId: number): ProfileRead {
    return { ...this.beginAccountRequest(userId), version: this.avatarVersion, sequence: ++this.avatarReads };
  }

  isCurrentAvatarRead(request: ProfileRead, userId: number | undefined): boolean {
    return this.isSameAccount(request, userId) && request.version === this.avatarVersion &&
      request.sequence === this.avatarReads;
  }

  beginAvatarWrite(userId: number): ProfileWrite {
    this.avatarVersion++;
    this.profileVersion++;
    return { ...this.beginAccountRequest(userId), sequence: ++this.avatarWrites };
  }

  isCurrentAvatarWrite(request: ProfileWrite, userId: number | undefined): boolean {
    return this.isSameAccount(request, userId) && request.sequence === this.avatarWrites;
  }

  finishAvatarWrite(request: ProfileWrite, userId: number | undefined): boolean {
    if (!this.isCurrentAvatarWrite(request, userId)) return false;
    this.avatarVersion++;
    this.profileVersion++;
    return true;
  }
}
