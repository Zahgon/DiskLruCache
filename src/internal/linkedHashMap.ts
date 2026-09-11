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

import { NoSuchElementException } from './errors';

/**
 * An access-ordered map: iteration runs from least- to most-recently-used.
 *
 * This is the cache's LRU policy, not a container detail. A plain `Map`
 * iterates in *insertion* order, which would evict the oldest-written entry
 * rather than the coldest one — the cache would still work, and its tests for
 * eviction-by-size would still pass, while quietly throwing away entries that
 * are being read constantly.
 *
 * Re-inserting a key in a `Map` moves it to the end, which is exactly the
 * reordering `LinkedHashMap` performs on access, so `get` deletes and re-sets.
 */
export class AccessOrderedMap<K, V> {
  private readonly entries = new Map<K, V>();

  /** Looks up `key`, moving it to the most-recently-used position. */
  get(key: K): V | null {
    if (!this.entries.has(key)) {
      return null;
    }
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Looks up `key` without disturbing the access order. */
  peek(key: K): V | null {
    const value = this.entries.get(key);
    return value === undefined ? null : value;
  }

  /** Stores `key`, moving it to the most-recently-used position. */
  put(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
  }

  /** Removes `key`, answering whether it was present. */
  remove(key: K): boolean {
    return this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /** The values, least-recently-used first. */
  values(): V[] {
    return [...this.entries.values()];
  }

  /** The least-recently-used key, as `entrySet().iterator().next()` yields. */
  eldestKey(): K {
    const first = this.entries.keys().next();
    if (first.done === true) {
      throw new NoSuchElementException();
    }
    return first.value;
  }
}
