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

import type { Charset } from './charset';
import type { OutputStream } from './streams';

/**
 * Character sinks.
 *
 * Buffering is observable here, not incidental. The cache flushes the journal
 * after `DIRTY` and after each completed edit, but deliberately does *not*
 * flush after `READ` — that is what keeps a read-heavy workload from paying a
 * write syscall per access, and it is why the journal file grows in steps
 * rather than smoothly. The buffer size matches the JDK's default so the
 * growth pattern matches too.
 */

const DEFAULT_BUFFER_SIZE = 8192;

/** A sink for characters. */
export interface Writer {
  write(text: string): void;
  flush(): void;
  close(): void;
}

/** Encodes characters onto a byte stream. */
export class OutputStreamWriter implements Writer {
  constructor(
    private readonly out: OutputStream,
    private readonly charset: Charset,
  ) {}

  write(text: string): void {
    const bytes = this.charset.encode(text);
    this.out.writeFrom(bytes, 0, bytes.length);
  }

  flush(): void {
    this.out.flush();
  }

  close(): void {
    this.out.close();
  }
}

/** Accumulates characters and writes them through in blocks. */
export class BufferedWriter implements Writer {
  private buffer = '';

  constructor(
    private readonly out: Writer,
    private readonly size: number = DEFAULT_BUFFER_SIZE,
  ) {}

  write(text: string): void {
    this.buffer += text;
    if (this.buffer.length >= this.size) {
      this.drain();
    }
  }

  flush(): void {
    this.drain();
    this.out.flush();
  }

  close(): void {
    this.drain();
    this.out.close();
  }

  private drain(): void {
    if (this.buffer.length > 0) {
      const pending = this.buffer;
      this.buffer = '';
      this.out.write(pending);
    }
  }
}
