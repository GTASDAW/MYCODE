// Only orders notification statistics. Identity and authentication generations
// stay in AuthProvider; each caller separately checks its account ticket.
export class NotificationRequestOrder {
  private version = 0;
  private sequence = 0;

  beginRead() {
    return { version: this.version, sequence: ++this.sequence };
  }

  invalidateReads() {
    this.version++;
  }

  isCurrent(read: { version: number; sequence: number }) {
    return read.version === this.version && read.sequence === this.sequence;
  }
}
