/**
 * In-process event bus → SSE — docs/09 § Events.
 *
 * Every event carries a monotonic `seq`, and a bounded ring buffer lets a client that
 * dropped its connection replay what it missed instead of silently losing progress.
 */
import { EventEmitter } from 'node:events';
import type { AppEvent } from '@ia/shared';

const RING_SIZE = 500;

/**
 * A plain `Omit` over a discriminated union collapses it to the shared keys, which would
 * make every event look like it has no payload. This distributes across the members.
 */
type Unsequenced<T> = T extends unknown ? Omit<T, 'seq'> : never;
export type AppEventInput = Unsequenced<AppEvent>;

class EventBus extends EventEmitter {
  private seq = 0;
  private ring: AppEvent[] = [];

  emitEvent(event: AppEventInput): AppEvent {
    const full = { ...event, seq: ++this.seq } as AppEvent;
    this.ring.push(full);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.emit('event', full);
    return full;
  }

  /** Everything after `afterSeq`, for a reconnecting client. */
  since(afterSeq: number): AppEvent[] {
    return this.ring.filter((e) => e.seq > afterSeq);
  }

  /** True when the requested position has already fallen out of the buffer. */
  hasGap(afterSeq: number): boolean {
    const oldest = this.ring[0];
    return oldest !== undefined && afterSeq > 0 && afterSeq < oldest.seq - 1;
  }

  get lastSeq(): number {
    return this.seq;
  }
}

export const events = new EventBus();
events.setMaxListeners(50);

export function publish(event: AppEventInput): void {
  events.emitEvent(event);
}
