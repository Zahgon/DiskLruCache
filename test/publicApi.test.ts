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

/**
 * Checks the package's entry point, which is what a consumer actually imports.
 *
 * The original's API surface was fixed by Java's `public` modifier and its
 * package layout; here it is fixed by what this barrel re-exports, so the
 * export list is worth asserting on directly. The rest of the suite imports
 * from the source modules and would not notice a member dropped from here.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import * as api from '../src/index';

/**
 * Asserts that an optional result is present and narrows it.
 *
 * Replaces the `expect(x).not.toBeNull(); if (x === null) return;` pattern:
 * the early return made the remainder of each test conditional, so weakening
 * the guard would have turned the rest of the body into dead code that still
 * reported as a pass.
 */
function required<T>(value: T | null | undefined, what = 'value'): T {
  expect(value, `expected a non-null ${what}`).not.toBeNull();
  expect(value, `expected a defined ${what}`).not.toBeUndefined();
  return value as T;
}

describe('public API', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'DiskLruCache-api-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('exports the journal constants with their contract values', () => {
    expect(api.JOURNAL_FILE).toEqual('journal');
    expect(api.JOURNAL_FILE_TEMP).toEqual('journal.tmp');
    expect(api.JOURNAL_FILE_BACKUP).toEqual('journal.bkp');
    expect(api.MAGIC).toEqual('libcore.io.DiskLruCache');
    expect(api.VERSION_1).toEqual('1');
    expect(api.ANY_SEQUENCE_NUMBER).toEqual(-1);
    expect(api.STRING_KEY_PATTERN).toEqual('[a-z0-9_-]{1,120}');
  });

  test('exports the cache, its companions and the error types', () => {
    expect(typeof api.DiskLruCache).toEqual('function');
    expect(typeof api.Snapshot).toEqual('function');
    expect(typeof api.Editor).toEqual('function');
    expect(typeof api.StrictLineReader).toEqual('function');
    expect(typeof api.InputStream).toEqual('function');
    expect(typeof api.OutputStream).toEqual('function');
    expect(typeof api.IOException).toEqual('function');
    expect(typeof api.EOFException).toEqual('function');
    expect(typeof api.FileNotFoundException).toEqual('function');
    expect(typeof api.IllegalArgumentException).toEqual('function');
    expect(typeof api.IllegalStateException).toEqual('function');
    expect(typeof api.NullPointerException).toEqual('function');
    expect(typeof api.NoSuchElementException).toEqual('function');
    expect(typeof api.UnsupportedEncodingException).toEqual('function');
    expect(typeof api.readFully).toEqual('function');
    expect(typeof api.deleteContents).toEqual('function');
    expect(typeof api.closeQuietly).toEqual('function');
    expect(api.US_ASCII.name).toEqual('US-ASCII');
    expect(api.UTF_8.name).toEqual('UTF-8');
  });

  test('a caller can complete the documented write-then-read cycle', () => {
    const cache = api.DiskLruCache.open(dir, 100, 2, 10 * 1024 * 1024);

    expect(cache.getDirectory()).toEqual(dir);
    expect(cache.getMaxSize()).toEqual(10 * 1024 * 1024);
    expect(cache.isClosed()).toBe(false);

    const editor = required(cache.edit('key1'), 'editor');
    editor.set(0, 'value');
    editor.set(1, 'metadata');
    editor.commit();

    const snapshot = required(cache.get('key1'), 'snapshot');
    expect(snapshot.getString(0)).toEqual('value');
    expect(snapshot.getString(1)).toEqual('metadata');
    expect(snapshot.getLength(0)).toEqual(5);
    snapshot.close();

    expect(cache.size()).toEqual(13);
    expect(cache.remove('key1')).toBe(true);
    expect(cache.get('key1')).toBeNull();

    cache.close();
    expect(cache.isClosed()).toBe(true);
  });

  test('abortUnlessCommitted releases an abandoned edit', () => {
    const cache = api.DiskLruCache.open(dir, 100, 2, 10 * 1024 * 1024);

    const first = required(cache.edit('key1'), 'first editor');
    first.set(0, 'partial');
    first.abortUnlessCommitted();

    // Aborting discards the edit rather than publishing it.
    expect(cache.get('key1')).toBeNull();
    expect(cache.size()).toEqual(0);

    // The edit lock was released, so a second edit may start, and it is a new
    // editor rather than the abandoned one handed back.
    const second = required(cache.edit('key1'), 'second editor');
    expect(second).not.toBe(first);
    second.abortUnlessCommitted();
    expect(cache.get('key1')).toBeNull();

    // `abortUnlessCommitted` only guards on the committed flag, so a second
    // call on an already-aborted editor still reaches `abort()` and fails the
    // current-editor check — the original behaves the same way.
    expect(() => {
      second.abortUnlessCommitted();
    }).toThrow(api.IllegalStateException);

    cache.close();
  });

  test('abortUnlessCommitted does nothing once the edit was committed', () => {
    const cache = api.DiskLruCache.open(dir, 100, 2, 10 * 1024 * 1024);

    const editor = required(cache.edit('key1'), 'editor');
    editor.set(0, 'a');
    editor.set(1, 'b');
    editor.commit();
    editor.abortUnlessCommitted();

    // The committed values survive the no-op abort, rather than the entry
    // merely still existing.
    const snapshot = required(cache.get('key1'), 'snapshot');
    expect(snapshot.getString(0)).toEqual('a');
    expect(snapshot.getString(1)).toEqual('b');
    expect(snapshot.getLength(0)).toEqual(1);
    snapshot.close();
    expect(cache.size()).toEqual(2);

    cache.close();
  });

  test('delete removes the cache contents and closes it', () => {
    const cache = api.DiskLruCache.open(dir, 100, 2, 10 * 1024 * 1024);
    const editor = required(cache.edit('key1'), 'editor');
    editor.set(0, 'a');
    editor.set(1, 'b');
    editor.commit();

    // The journal and both value files exist before the delete, so the empty
    // directory below is the delete's doing and not a cache that never wrote.
    expect(fs.existsSync(path.join(dir, api.JOURNAL_FILE))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'key1.0'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'key1.1'))).toBe(true);

    cache.delete();

    expect(cache.isClosed()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
    // The directory itself survives; only its contents go.
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('setMaxSize is reflected by getMaxSize and evicts down to the new bound', async () => {
    const cache = api.DiskLruCache.open(dir, 100, 2, 100);
    // 5 entries x 10 bytes = 50 bytes, comfortably under the initial bound.
    for (let i = 0; i < 5; i++) {
      const editor = required(cache.edit(`key${String(i)}`), `editor ${String(i)}`);
      editor.set(0, 'aaaaa');
      editor.set(1, 'bbbbb');
      editor.commit();
    }
    expect(cache.size()).toEqual(50);
    expect(cache.getMaxSize()).toEqual(100);

    cache.setMaxSize(20);
    expect(cache.getMaxSize()).toEqual(20);

    // Trimming is queued on the background worker, as in the original, so it
    // lands on a later turn of the event loop rather than inside setMaxSize.
    await new Promise((resolve) => setImmediate(resolve));

    expect(cache.size()).toBeLessThanOrEqual(20);
    // Eviction is least-recently-used, so the oldest keys went first.
    expect(cache.get('key0')).toBeNull();
    expect(cache.get('key1')).toBeNull();
    const survivor = required(cache.get('key4'), 'most recent entry');
    expect(survivor.getString(0)).toEqual('aaaaa');
    survivor.close();

    cache.close();
  });

  test('newOutputStream rejects an index outside the value count', () => {
    const cache = api.DiskLruCache.open(dir, 100, 2, 10 * 1024 * 1024);
    const editor = required(cache.edit('key1'), 'editor');
    expect(() => editor.newOutputStream(2)).toThrow(
      'Expected index 2 to be greater than 0 and less than the maximum value count of 2',
    );
    expect(() => editor.newOutputStream(-1)).toThrow(api.IllegalArgumentException);
    editor.abort();
    cache.close();
  });

  test('operations on a closed cache raise IllegalStateException', () => {
    const cache = api.DiskLruCache.open(dir, 100, 2, 10 * 1024 * 1024);
    cache.close();
    expect(() => cache.get('key1')).toThrow(api.IllegalStateException);
    expect(() => cache.edit('key1')).toThrow('cache is closed');
    expect(() => cache.remove('key1')).toThrow(api.IllegalStateException);
    expect(() => {
      cache.flush();
    }).toThrow(api.IllegalStateException);
  });
});
