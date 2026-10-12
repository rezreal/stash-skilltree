// Test doubles for the gaze sources: a manual clock with timers.

import type { Timers } from "../../src/gaze/rate.ts";

export class FakeClock implements Timers {
  t = 0;
  private seq = 0;
  private queue: { id: number; at: number; fn: () => void }[] = [];

  now = (): number => this.t;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.queue.push({ id, at: this.t + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((q) => q.id !== handle);
  }

  /** advances time, running due timers in order */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0];
      if (next === undefined || next.at > end) break;
      this.queue.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }

  get pending(): number {
    return this.queue.length;
  }
}

export class FakeTarget {
  listeners = new Map<string, Set<(e: Event) => void>>();
  addEventListener(type: string, cb: (e: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: (e: Event) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  dispatch(type: string, e: object = {}): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(e as Event);
  }
  count(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}
