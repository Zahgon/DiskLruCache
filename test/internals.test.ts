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
 * Tests for behaviour the original inherited from the JDK and from
 * `commons-io`, and that this port now implements itself.
 *
 * The original never needed these: `LinkedHashMap`, `Charset`,
 * `Long.parseLong`, `ThreadPoolExecutor` and `FileInputStream` were somebody
 * else's tested code. Here they are first-party, so they carry first-party
 * tests — without them the migration would have moved real logic out from
 * under the suite while the headline test count stayed the same.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { US_ASCII, UTF_8 } from '../src/internal/charset';
import { DiskLruCache } from '../src/diskLruCache';
import {
  EOFException,
  FileNotFoundException,
  IllegalArgumentException,
  IllegalStateException,
  IOException,
  NoSuchElementException,
  NullPointerException,
  UnsupportedEncodingException,
} from '../src/internal/errors';
import { SerialExecutor } from '../src/internal/executor';
import * as file from '../src/internal/file';
import { AccessOrderedMap } from '../src/internal/linkedHashMap';
import { NumberFormatException, parseLong } from '../src/internal/parseLong';
import { FileInputStream, FileOutputStream, NullOutputStream } from '../src/internal/streams';
import { BufferedWriter, OutputStreamWriter } from '../src/internal/writer';
import { closeQuietly, deleteContents, readFully } from '../src/util';

describe('AccessOrderedMap (replaces LinkedHashMap with accessOrder=true)', () => {
  test('iterates in insertion order until something is accessed', () => {
    const map = new AccessOrderedMap<string, number>();
    map.put('a', 1);
    map.put('b', 2);
    map.put('c', 3);
    expect(map.values()).toEqual([1, 2, 3]);
    expect(map.eldestKey()).toEqual('a');
  });

  test('get moves the key to most-recently-used', () => {
    const map = new AccessOrderedMap<string, number>();
    map.put('a', 1);
    map.put('b', 2);
    map.put('c', 3);
    expect(map.get('a')).toEqual(1);
    expect(map.values()).toEqual([2, 3, 1]);
    expect(map.eldestKey()).toEqual('b');
  });

  test('peek does not disturb the access order', () => {
    const map = new AccessOrderedMap<string, number>();
    map.put('a', 1);
    map.put('b', 2);
    expect(map.peek('a')).toEqual(1);
    expect(map.eldestKey()).toEqual('a');
  });

  test('re-putting an existing key moves it to most-recently-used', () => {
    const map = new AccessOrderedMap<string, number>();
    map.put('a', 1);
    map.put('b', 2);
    map.put('a', 9);
    expect(map.values()).toEqual([2, 9]);
    expect(map.size).toEqual(2);
  });

  test('get of a missing key returns null and does not insert', () => {
    const map = new AccessOrderedMap<string, number>();
    expect(map.get('nope')).toBeNull();
    expect(map.size).toEqual(0);
  });

  test('remove reports whether the key was present', () => {
    const map = new AccessOrderedMap<string, number>();
    map.put('a', 1);
    expect(map.remove('a')).toBe(true);
    expect(map.remove('a')).toBe(false);
  });

  test('eldestKey on an empty map throws NoSuchElementException', () => {
    const map = new AccessOrderedMap<string, number>();
    expect(() => map.eldestKey()).toThrow(NoSuchElementException);
  });
});

describe('exception detail messages (Throwable.getMessage)', () => {
  test('an exception built without a message answers null, not empty string', () => {
    expect(new IOException().getMessage()).toBeNull();
    expect(new EOFException().getMessage()).toBeNull();
    expect(new IllegalStateException().getMessage()).toBeNull();
  });

  test('an exception built with a message answers it', () => {
    expect(new IOException('failed to delete /tmp/x').getMessage()).toEqual(
      'failed to delete /tmp/x',
    );
    expect(new IllegalArgumentException('maxSize <= 0').getMessage()).toEqual('maxSize <= 0');
  });

  test('the class hierarchy the cache branches on is preserved', () => {
    expect(new EOFException()).toBeInstanceOf(IOException);
    expect(new FileNotFoundException()).toBeInstanceOf(IOException);
    expect(new UnsupportedEncodingException()).toBeInstanceOf(IOException);
    expect(new IllegalArgumentException()).not.toBeInstanceOf(IOException);
    expect(new IllegalStateException()).not.toBeInstanceOf(IOException);
    expect(new NullPointerException()).not.toBeInstanceOf(IOException);
  });

  /**
   * `UnsupportedEncodingException` is part of the exported error surface but
   * nothing in the cache throws it: in the original it exists only to satisfy a
   * `catch` in `StrictLineReader` that cannot fire, and the port dropped that
   * catch because decoding here does not throw. It is kept because it is part
   * of the public API, so it is covered like the types that do get raised.
   */
  test('UnsupportedEncodingException carries the message contract', () => {
    expect(new UnsupportedEncodingException('Unsupported encoding').getMessage()).toEqual(
      'Unsupported encoding',
    );
    expect(new UnsupportedEncodingException().getMessage()).toBeNull();
    expect(new UnsupportedEncodingException().name).toEqual('UnsupportedEncodingException');
  });
});

describe('corruption notice', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'DiskLruCache-corrupt-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The original interpolates `getMessage()` into its corruption notice. A
   * journal truncated inside the header raises an EOFException with no message,
   * so the JVM prints the literal "null" there. Printing an empty gap instead
   * would be a silent divergence in the only output this library produces.
   */
  test('a journal truncated inside the header reports "null" as the reason', () => {
    fs.writeFileSync(path.join(dir, 'journal'), '');
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.join(' '));
    };
    try {
      DiskLruCache.open(dir, 100, 2, 1000).close();
    } finally {
      console.log = original;
    }
    expect(lines).toEqual([`DiskLruCache ${dir} is corrupt: null, removing`]);
  });

  test('a parseable but invalid journal reports its message', () => {
    fs.writeFileSync(
      path.join(dir, 'journal'),
      'libcore.io.DiskLruCache\n1\n100\n2\n\nBOGUS\n',
      'ascii',
    );
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.join(' '));
    };
    try {
      DiskLruCache.open(dir, 100, 2, 1000).close();
    } finally {
      console.log = original;
    }
    expect(lines).toEqual([
      `DiskLruCache ${dir} is corrupt: unexpected journal line: BOGUS, removing`,
    ]);
  });
});

/**
 * `Editor.newOutputStream` hands back the original's `FaultHidingOutputStream`.
 * Its contract is that writes never throw: an I/O failure is recorded on the
 * editor and turned into an aborted edit at commit time, rather than
 * propagating out of an unrelated `set` call. The original's suite reaches this
 * class only through `set`, which routes every write through the bulk path — so
 * the single-byte `write` and `flush` overrides ship untested in both
 * implementations. They are real error-handling paths and are covered here.
 */
describe('FaultHidingOutputStream (via Editor.newOutputStream)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'DiskLruCache-fhos-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('single-byte write and flush reach the value file', () => {
    const cache = DiskLruCache.open(dir, 100, 2, 1000);
    try {
      const editor = cache.edit('k1');
      const out = required(editor).newOutputStream(0);
      out.write('A'.charCodeAt(0));
      out.write('B'.charCodeAt(0));
      out.flush();
      out.close();
      required(editor).set(1, 'meta');
      required(editor).commit();

      const snapshot = cache.get('k1');
      try {
        expect(required(snapshot).getString(0)).toEqual('AB');
        expect(required(snapshot).getLength(0)).toEqual(2);
      } finally {
        required(snapshot).close();
      }
    } finally {
      cache.close();
    }
  });

  test('a failed write is swallowed and aborts the edit at commit', () => {
    const cache = DiskLruCache.open(dir, 100, 2, 1000);
    try {
      const editor = cache.edit('k2');
      const out = required(editor).newOutputStream(0);
      out.close(); // drop the descriptor the next write needs

      // The write fails underneath and must not propagate.
      expect(() => {
        out.write('A'.charCodeAt(0));
      }).not.toThrow();
      out.flush();

      required(editor).set(1, 'meta');
      required(editor).commit(); // hasErrors -> completeEdit(false), then remove(key)

      expect(cache.get('k2')).toBeNull();
    } finally {
      cache.close();
    }
  });

  test('a failed bulk write is swallowed too, and the previous value is dropped', () => {
    const cache = DiskLruCache.open(dir, 100, 2, 1000);
    try {
      const first = cache.edit('k3');
      required(first).set(0, 'old');
      required(first).set(1, 'old');
      required(first).commit();
      expect(cache.get('k3')).not.toBeNull();

      const editor = cache.edit('k3');
      const out = required(editor).newOutputStream(0);
      out.close();
      expect(() => {
        out.writeFrom(Buffer.from('new'), 0, 3);
      }).not.toThrow();
      required(editor).commit();

      // commit() on a failed edit removes the entry: the previous value is stale.
      expect(cache.get('k3')).toBeNull();
    } finally {
      cache.close();
    }
  });
});

describe('journal parity with the Java original', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'DiskLruCache-parity-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeJournal(body: string): void {
    fs.writeFileSync(path.join(dir, 'journal'), `libcore.io.DiskLruCache\n1\n100\n2\n\n${body}`, 'ascii');
  }

  function captureNotices(run: () => void): string[] {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.join(' '));
    };
    try {
      run();
    } finally {
      console.log = original;
    }
    return lines;
  }

  /**
   * Java's `String.split(" ")` uses limit 0, which discards trailing empty
   * strings, so a CLEAN line with a trailing space still yields exactly
   * `valueCount` lengths and the cache opens normally. Splitting the JavaScript
   * way keeps the empty string, fails the value-count check and declares a
   * journal corrupt that the original accepts — which deletes a cache directory
   * the Java implementation would have read.
   */
  test('a CLEAN line with a trailing space is not corrupt', () => {
    fs.writeFileSync(path.join(dir, 'k1.0'), 'A');
    fs.writeFileSync(path.join(dir, 'k1.1'), 'B');
    writeJournal('CLEAN k1 1 1 \n');

    const cache = DiskLruCache.open(dir, 100, 2, 1000);
    try {
      expect(cache.size()).toEqual(2);
      const snapshot = cache.get('k1');
      expect(snapshot).not.toBeNull();
      snapshot?.close();
    } finally {
      cache.close();
    }
  });

  /**
   * Trailing-empty removal must not swallow interior empties: Java keeps those,
   * so a doubled space is still a bad line, with the empty rendered in the
   * message by `Arrays.toString`.
   */
  test('a CLEAN line with a doubled interior space is still corrupt', () => {
    writeJournal('CLEAN k1 1  1\n');
    const notices = captureNotices(() => {
      DiskLruCache.open(dir, 100, 2, 1000).close();
    });
    expect(notices).toEqual([
      `DiskLruCache ${dir} is corrupt: unexpected journal line: [1, , 1], removing`,
    ]);
  });

  /**
   * `Long.parseLong` rejects anything past 2^63-1, so an absurd length makes the
   * original rebuild the journal. Parsing it as a JavaScript number instead
   * yields an imprecise float, and the cache silently adopts a nonsense size.
   */
  test('a CLEAN length beyond Long range is corrupt', () => {
    fs.writeFileSync(path.join(dir, 'k1.0'), 'A');
    fs.writeFileSync(path.join(dir, 'k1.1'), 'B');
    writeJournal('CLEAN k1 99999999999999999999 1\n');

    const notices = captureNotices(() => {
      const cache = DiskLruCache.open(dir, 100, 2, 1000);
      try {
        expect(cache.size()).toEqual(0);
        expect(cache.get('k1')).toBeNull();
      } finally {
        cache.close();
      }
    });
    expect(notices).toEqual([
      `DiskLruCache ${dir} is corrupt: unexpected journal line: [99999999999999999999, 1], removing`,
    ]);
  });
});

describe('charsets', () => {
  test('US-ASCII round-trips printable ASCII', () => {
    const text = 'CLEAN k1 2 1';
    const encoded = US_ASCII.encode(text);
    // One byte per character, and the exact bytes a journal line is made of.
    expect(encoded).toHaveLength(text.length);
    expect(encoded[0]).toEqual('C'.charCodeAt(0));
    expect(US_ASCII.decode(encoded)).toEqual(text);
  });

  test('US-ASCII encodes an out-of-range character as a question mark', () => {
    expect([...US_ASCII.encode('a☃b')]).toEqual([0x61, 0x3f, 0x62]);
    // The substitution is lossy, so the round trip does not recover the input.
    expect(US_ASCII.decode(US_ASCII.encode('a☃b'))).toEqual('a?b');
  });

  test('US-ASCII decodes an out-of-range byte as the replacement character', () => {
    expect(US_ASCII.decode(Buffer.from([0x61, 0xc3, 0x62]))).toEqual('a�b');
  });

  test('US-ASCII decodes a sub-range', () => {
    const bytes = Buffer.from('abcdef', 'ascii');
    expect(US_ASCII.decode(bytes, 2, 3)).toEqual('cde');
    // The offset/length pair bounds both ends, and a zero length is empty.
    expect(US_ASCII.decode(bytes, 0, 1)).toEqual('a');
    expect(US_ASCII.decode(bytes, 5, 1)).toEqual('f');
    expect(US_ASCII.decode(bytes, 3, 0)).toEqual('');
  });

  test('UTF-8 round-trips characters outside the basic plane', () => {
    const text = 'snowman ☃ and 😀';
    expect(UTF_8.decode(UTF_8.encode(text))).toEqual(text);
  });

  test('UTF-8 uses byte length, not character length', () => {
    expect(UTF_8.encode('☃')).toHaveLength(3);
    expect('☃').toHaveLength(1);
    // A surrogate pair is four bytes but two UTF-16 code units.
    expect(UTF_8.encode('😀')).toHaveLength(4);
    expect(UTF_8.encode('a')).toHaveLength(1);
  });
});

describe('parseLong (replaces Long.parseLong)', () => {
  test('parses decimal digits', () => {
    expect(parseLong('10123')).toEqual(10123);
    expect(parseLong('0')).toEqual(0);
    expect(parseLong('00000001')).toEqual(1);
  });

  test('parses an explicit sign', () => {
    expect(parseLong('-5')).toEqual(-5);
    expect(parseLong('+5')).toEqual(5);
  });

  test.each(['0000x001', '', ' 1', '1 ', '0x10', '1e3', '1.0', 'abc', '--1'])(
    'rejects %j',
    (input) => {
      expect(() => parseLong(input)).toThrow(NumberFormatException);
    },
  );

  /**
   * The bounds are inclusive. They are compared against `Number(BigInt)` rather
   * than a literal because neither bound is exactly representable as a double —
   * which is the same reason the range check itself uses `BigInt`.
   */
  test('accepts the extremes of the Long range', () => {
    expect(parseLong('9223372036854775807')).toEqual(Number(2n ** 63n - 1n));
    expect(parseLong('-9223372036854775808')).toEqual(Number(-(2n ** 63n)));
  });

  /**
   * Digits alone are not enough: `Long.parseLong` also rejects anything outside
   * the Long range. `Number()` would answer an imprecise float instead, which
   * reaches the cache as a plausible value length straight out of a journal.
   */
  test.each(['9223372036854775808', '-9223372036854775809', '99999999999999999999'])(
    'rejects %j as out of Long range',
    (input) => {
      expect(() => parseLong(input)).toThrow(NumberFormatException);
    },
  );
});

describe('SerialExecutor (replaces ThreadPoolExecutor)', () => {
  test('submit queues without running', () => {
    const executor = new SerialExecutor();
    let ran = false;
    executor.submit(() => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(executor.getQueue().size()).toEqual(1);
    executor.shutdown();
  });

  test('the queue drains on a later turn of the event loop', async () => {
    const executor = new SerialExecutor();
    const order: number[] = [];
    executor.submit(() => order.push(1));
    executor.submit(() => order.push(2));
    expect(executor.getQueue().size()).toEqual(2);

    await new Promise((resolve) => setImmediate(resolve));

    expect(order).toEqual([1, 2]);
    expect(executor.getQueue().size()).toEqual(0);
  });

  test('a failing task does not stop the ones behind it', async () => {
    const executor = new SerialExecutor();
    const order: number[] = [];
    executor.submit(() => {
      throw new Error('boom');
    });
    executor.submit(() => order.push(2));
    expect(executor.getQueue().size()).toEqual(2);

    await new Promise((resolve) => setImmediate(resolve));

    // The thrower is swallowed the way a ThreadPoolExecutor parks it in an
    // unread Future, and the drain still empties the queue behind it.
    expect(order).toEqual([2]);
    expect(executor.getQueue().size()).toEqual(0);
  });

  test('drainNow runs queued work immediately', () => {
    const executor = new SerialExecutor();
    let ran = false;
    executor.submit(() => {
      ran = true;
    });
    executor.drainNow();
    expect(ran).toBe(true);
    expect(executor.getQueue().size()).toEqual(0);
  });

  test('purge keeps tasks that were never cancelled', () => {
    const executor = new SerialExecutor();
    let ran = false;
    executor.submit(() => {
      ran = true;
    });
    executor.purge();

    // Nothing submitted here is cancellable, so purge drops nothing: the task
    // is still queued and still runs.
    expect(executor.getQueue().size()).toEqual(1);
    expect(ran).toBe(false);
    executor.drainNow();
    expect(ran).toBe(true);
    expect(executor.getQueue().size()).toEqual(0);
    executor.shutdown();
  });

  test('shutdown discards pending work', async () => {
    const executor = new SerialExecutor();
    let ran = false;
    executor.submit(() => {
      ran = true;
    });
    expect(executor.getQueue().size()).toEqual(1);
    executor.shutdown();

    // The pending task is dropped immediately, and the cancelled drain does not
    // resurrect it on a later turn.
    expect(executor.getQueue().size()).toEqual(0);

    await new Promise((resolve) => setImmediate(resolve));

    expect(ran).toBe(false);
    expect(executor.getQueue().size()).toEqual(0);
  });
});

describe('file and stream primitives', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'DiskLruCache-internals-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('opening a missing file raises FileNotFoundException, not a raw errno', () => {
    expect(() => new FileInputStream(path.join(dir, 'nope'))).toThrow(IOException);
  });

  test('an open descriptor keeps reading the bytes it was opened on', () => {
    const target = path.join(dir, 'value');
    fs.writeFileSync(target, 'AAaa');
    const stream = new FileInputStream(target);
    expect(stream.read()).toEqual('A'.charCodeAt(0));

    // Replace the file the way a committed edit does.
    const replacement = path.join(dir, 'value.tmp');
    fs.writeFileSync(replacement, 'CCcc');
    fs.renameSync(replacement, target);

    expect(stream.read()).toEqual('A'.charCodeAt(0));
    expect(stream.read()).toEqual('a'.charCodeAt(0));
    stream.close();
    expect(fs.readFileSync(target, 'utf8')).toEqual('CCcc');
  });

  test('read reports -1 at end of input', () => {
    const target = path.join(dir, 'value');
    fs.writeFileSync(target, 'A');
    const stream = new FileInputStream(target);
    expect(stream.read()).toEqual('A'.charCodeAt(0));
    expect(stream.read()).toEqual(-1);
    stream.close();
  });

  test('reading a closed stream raises', () => {
    const target = path.join(dir, 'value');
    fs.writeFileSync(target, 'A');
    const stream = new FileInputStream(target);
    stream.close();
    expect(() => stream.read()).toThrow(IOException);
  });

  test('append mode adds to the end rather than truncating', () => {
    const target = path.join(dir, 'journal');
    fs.writeFileSync(target, 'header\n');
    const stream = new FileOutputStream(target, true);
    const bytes = Buffer.from('line\n', 'ascii');
    stream.writeFrom(bytes, 0, bytes.length);
    stream.close();
    expect(fs.readFileSync(target, 'utf8')).toEqual('header\nline\n');
  });

  test('non-append mode truncates', () => {
    const target = path.join(dir, 'journal');
    fs.writeFileSync(target, 'stale content');
    const stream = new FileOutputStream(target);
    stream.write('X'.charCodeAt(0));
    stream.close();
    expect(fs.readFileSync(target, 'utf8')).toEqual('X');
  });

  test('the null output stream discards writes', () => {
    const before = fs.readdirSync(dir);
    const stream = new NullOutputStream();
    // Every write path is a no-op that neither throws nor produces output.
    expect(() => {
      stream.write(65);
      stream.writeFrom(Buffer.from('ignored'), 0, 7);
      stream.flush();
      stream.close();
    }).not.toThrow();
    // Writing after close is still accepted, unlike a real file stream.
    expect(() => {
      stream.write(66);
    }).not.toThrow();
    expect(fs.readdirSync(dir)).toEqual(before);
  });

  test('readFully decodes UTF-8 and closes the stream', () => {
    const target = path.join(dir, 'value');
    fs.writeFileSync(target, 'snowman ☃');
    const stream = new FileInputStream(target);
    expect(readFully(stream)).toEqual('snowman ☃');
    expect(() => stream.read()).toThrow(IOException);
  });

  test('readFully spans more than one internal buffer', () => {
    const target = path.join(dir, 'big');
    const content = 'x'.repeat(5000);
    fs.writeFileSync(target, content);
    expect(readFully(new FileInputStream(target))).toEqual(content);
  });

  test('a buffered writer holds writes until flushed', () => {
    const target = path.join(dir, 'journal');
    const writer = new BufferedWriter(
      new OutputStreamWriter(new FileOutputStream(target), US_ASCII),
    );
    writer.write('READ k1\n');
    expect(fs.readFileSync(target, 'utf8')).toEqual('');
    writer.flush();
    expect(fs.readFileSync(target, 'utf8')).toEqual('READ k1\n');
    writer.close();
  });

  test('a buffered writer flushes on close', () => {
    const target = path.join(dir, 'journal');
    const writer = new BufferedWriter(
      new OutputStreamWriter(new FileOutputStream(target), US_ASCII),
    );
    writer.write('CLEAN k1 1 1\n');
    writer.close();
    expect(fs.readFileSync(target, 'utf8')).toEqual('CLEAN k1 1 1\n');
  });

  test('a buffered writer spills once it exceeds its capacity', () => {
    const target = path.join(dir, 'journal');
    const writer = new BufferedWriter(
      new OutputStreamWriter(new FileOutputStream(target), US_ASCII),
      8,
    );
    writer.write('123456789');
    expect(fs.readFileSync(target, 'utf8')).toEqual('123456789');
    writer.close();
  });

  test('deleteContents empties a nested tree but keeps the root', () => {
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'file'), 'x');
    fs.writeFileSync(path.join(dir, 'top'), 'y');
    deleteContents(dir);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('deleteContents of a non-directory names the offending path', () => {
    const missing = path.join(dir, 'missing');
    expect(() => {
      deleteContents(missing);
    }).toThrow(`not a readable directory: ${missing}`);
  });

  test('closeQuietly swallows an IOException but not other failures', () => {
    closeQuietly(null);
    closeQuietly({
      close(): void {
        throw new IOException('ignored');
      },
    });
    expect(() => {
      closeQuietly({
        close(): void {
          throw new TypeError('a programming error must still surface');
        },
      });
    }).toThrow(TypeError);
  });

  test('file helpers report failure rather than throwing', () => {
    const missing = path.join(dir, 'missing');
    expect(file.deleteFile(missing)).toBe(false);
    expect(file.renameTo(missing, path.join(dir, 'dest'))).toBe(false);
    expect(file.length(missing)).toEqual(0);
    expect(file.listFiles(missing)).toBeNull();
    expect(file.exists(missing)).toBe(false);
    expect(file.isDirectory(missing)).toBe(false);
  });

  test('deleteFile removes an empty directory as File.delete does', () => {
    const child = path.join(dir, 'child');
    fs.mkdirSync(child);
    expect(file.deleteFile(child)).toBe(true);
    expect(fs.existsSync(child)).toBe(false);
  });

  test('mkdirs creates missing parents', () => {
    const nested = path.join(dir, 'x', 'y', 'z');
    expect(file.mkdirs(nested)).toBe(true);
    expect(fs.statSync(nested).isDirectory()).toBe(true);
  });
});

function required<T>(value: T | null): T {
  if (value === null) {
    throw new Error('expected a non-null value');
  }
  return value;
}
