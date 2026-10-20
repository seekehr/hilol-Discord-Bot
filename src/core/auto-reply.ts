export interface AutoCandidate {
  channelId: string;
  messageId: string;
  userId: string;
  createdAt: number;
}
interface Pending {
  candidate: AutoCandidate;
  timer: ReturnType<typeof setTimeout>;
}

// A fixed window coalesces activity; new messages update the candidate without postponing the timer.
export class AutoReplyScheduler {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly deliver: (candidate: AutoCandidate) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly random = Math.random,
  ) {}

  schedule(candidate: AutoCandidate, minSeconds: number, maxSeconds: number): void {
    const existing = this.pending.get(candidate.channelId);
    if (existing) {
      existing.candidate = candidate;
      return;
    }
    const milliseconds = (minSeconds + this.random() * (maxSeconds - minSeconds)) * 1_000;
    const pending: Pending = {
      candidate,
      timer: setTimeout(() => {
        this.pending.delete(candidate.channelId);
        void this.deliver(pending.candidate).catch(this.onError);
      }, milliseconds),
    };
    pending.timer.unref();
    this.pending.set(candidate.channelId, pending);
  }

  cancel(channelId: string): void {
    const pending = this.pending.get(channelId);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(channelId);
  }

  cancelUser(userId: string): void {
    for (const [id, pending] of this.pending)
      if (pending.candidate.userId === userId) this.cancel(id);
  }

  clear(): void {
    for (const id of this.pending.keys()) this.cancel(id);
  }
  get size(): number {
    return this.pending.size;
  }
}
