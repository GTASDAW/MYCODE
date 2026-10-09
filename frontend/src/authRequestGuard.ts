export interface AccountRequest {
  generation: number;
  userId: number;
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

  beginAuthentication(): number {
    this.profileVersion++;
    return ++this.generation;
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
}
