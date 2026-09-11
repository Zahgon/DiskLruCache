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

import * as fs from 'node:fs';

import { FileNotFoundException, IOException } from './errors';

/**
 * Blocking byte streams over file descriptors.
 *
 * A cache snapshot must keep reading the bytes that were published when `get`
 * was called, even after the entry is re-committed and the clean file replaced
 * underneath it. That guarantee comes from holding an open file descriptor: the
 * descriptor keeps the original inode alive after the directory entry is
 * replaced. Node's `ReadStream` would not do — it is asynchronous, and the
 * cache's single-threaded, `synchronized` design depends on reads and writes
 * completing before the next operation is allowed to observe the cache. So
 * these are thin synchronous wrappers over `fs.readSync` / `fs.writeSync`.
 */

/** A source of bytes. */
export abstract class InputStream {
  /** Reads one byte, or returns `-1` at end of input. */
  abstract read(): number;

  /**
   * Reads up to `length` bytes into `buffer` at `offset`, returning the number
   * of bytes read, or `-1` at end of input.
   */
  abstract readInto(buffer: Buffer, offset: number, length: number): number;

  abstract close(): void;
}

/** A sink for bytes. */
export abstract class OutputStream {
  /** Writes the low eight bits of `oneByte`. */
  abstract write(oneByte: number): void;

  /** Writes `length` bytes from `buffer` starting at `offset`. */
  abstract writeFrom(buffer: Buffer, offset: number, length: number): void;

  abstract flush(): void;

  abstract close(): void;
}

/** Reads a file through an open descriptor. */
export class FileInputStream extends InputStream {
  private fd: number | null;
  private readonly single = Buffer.allocUnsafe(1);

  constructor(file: string) {
    super();
    try {
      this.fd = fs.openSync(file, 'r');
    } catch {
      throw new FileNotFoundException(`${file} (No such file or directory)`);
    }
  }

  override read(): number {
    const count = this.readInto(this.single, 0, 1);
    return count === -1 ? -1 : (this.single[0] as number);
  }

  override readInto(buffer: Buffer, offset: number, length: number): number {
    if (this.fd === null) {
      throw new IOException('Stream Closed');
    }
    if (length === 0) {
      return 0;
    }
    const count = fs.readSync(this.fd, buffer, offset, length, null);
    return count === 0 ? -1 : count;
  }

  override close(): void {
    if (this.fd !== null) {
      const fd = this.fd;
      this.fd = null;
      fs.closeSync(fd);
    }
  }
}

/** Writes a file through an open descriptor. */
export class FileOutputStream extends OutputStream {
  private fd: number | null;
  private readonly single = Buffer.allocUnsafe(1);

  constructor(file: string, append = false) {
    super();
    try {
      this.fd = fs.openSync(file, append ? 'a' : 'w');
    } catch {
      throw new FileNotFoundException(`${file} (No such file or directory)`);
    }
  }

  override write(oneByte: number): void {
    this.single[0] = oneByte & 0xff;
    this.writeFrom(this.single, 0, 1);
  }

  override writeFrom(buffer: Buffer, offset: number, length: number): void {
    if (this.fd === null) {
      throw new IOException('Stream Closed');
    }
    let written = 0;
    while (written < length) {
      written += fs.writeSync(this.fd, buffer, offset + written, length - written);
    }
  }

  /**
   * A file descriptor has no userspace buffer to push, so this is a no-op —
   * exactly as `FileOutputStream.flush()` is in the JDK.
   */
  override flush(): void {
    // Nothing is buffered at this level.
  }

  override close(): void {
    if (this.fd !== null) {
      const fd = this.fd;
      this.fd = null;
      fs.closeSync(fd);
    }
  }
}

/** A stream that discards every byte written to it. */
export class NullOutputStream extends OutputStream {
  override write(_oneByte: number): void {
    // Eat all writes silently. Nom nom.
  }

  override writeFrom(_buffer: Buffer, _offset: number, _length: number): void {
    // Eat all writes silently. Nom nom.
  }

  override flush(): void {
    // Nothing to do.
  }

  override close(): void {
    // Nothing to do.
  }
}
