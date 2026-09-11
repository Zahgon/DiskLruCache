/*
 * Copyright (C) 2011 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** A task submitted for background execution. */
export type Runnable = () => void;

/**
 * The cache's single background worker.
 *
 * The original uses `ThreadPoolExecutor(0, 1, 60s, LinkedBlockingQueue)`: work
 * is queued, at most one task runs at a time, and — crucially — submitting does
 * not run the task. Eviction and journal compaction are therefore *deferred*,
 * which is why the cache may sit over its size limit for a moment and why
 * callers that need a trimmed cache call `flush()`.
 *
 * Node has no background thread to hand the work to, so the queue is drained on
 * the next turn of the event loop. That preserves what actually matters: the
 * task is queued but not yet run when `submit` returns, it runs without the
 * caller asking, and only one runs at a time. It does mean a caller that never
 * yields to the event loop will never see the queue drain.
 *
 * The drain is unref'd so a pending cleanup cannot hold the process open — the
 * original's worker threads are likewise not a reason for the JVM to stay up,
 * since the pool's core size is zero.
 */
export class SerialExecutor {
  private readonly queue: Runnable[] = [];
  private scheduled: NodeJS.Immediate | null = null;
  private draining = false;

  /** Queues `task` to run on a later turn of the event loop. */
  submit(task: Runnable): void {
    this.queue.push(task);
    this.schedule();
  }

  /** The pending tasks, as `ThreadPoolExecutor.getQueue()` exposes them. */
  getQueue(): { size(): number } {
    return { size: (): number => this.queue.length };
  }

  /**
   * Drops tasks that were cancelled. Nothing submitted here is cancellable, so
   * — as in the original, where no cleanup future is ever cancelled — there is
   * nothing to drop.
   */
  purge(): void {
    // No cancellable tasks.
  }

  /** Runs every queued task now, rather than waiting for the event loop. */
  drainNow(): void {
    this.cancelSchedule();
    this.drain();
  }

  /** Discards pending work and stops the scheduled drain. */
  shutdown(): void {
    this.cancelSchedule();
    this.queue.length = 0;
  }

  private schedule(): void {
    if (this.scheduled !== null || this.draining) {
      return;
    }
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      this.drain();
    });
    this.scheduled.unref();
  }

  private cancelSchedule(): void {
    if (this.scheduled !== null) {
      clearImmediate(this.scheduled);
      this.scheduled = null;
    }
  }

  private drain(): void {
    this.draining = true;
    try {
      for (let task = this.queue.shift(); task !== undefined; task = this.queue.shift()) {
        try {
          task();
        } catch {
          // A ThreadPoolExecutor captures the failure in the task's Future.
          // Nothing calls get() on it, so the failure is dropped either way.
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
