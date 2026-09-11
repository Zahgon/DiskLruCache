/*
 * Copyright (C) 2012 The Android Open Source Project
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

import type { Charset } from './internal/charset';
import { US_ASCII } from './internal/charset';
import { EOFException, IllegalArgumentException, IOException } from './internal/errors';
import type { InputStream } from './internal/streams';
import type { Closeable } from './util';

const CR = 0x0d;
const LF = 0x0a;
const DEFAULT_CAPACITY = 8192;

/**
 * Buffers input from an InputStream for reading lines.
 *
 * This class is used for buffered reading of lines. For purposes of this class, a line ends
 * with "\n" or "\r\n". End of input is reported by throwing EOFException. Unterminated
 * line at end of input is invalid and will be ignored, the caller may use
 * `hasUnterminatedLine()` to detect it after catching the EOFException.
 *
 * This class is intended for reading input that strictly consists of lines, such as line-based
 * cache entries or cache journal. Unlike a general-purpose line reader, this class uses different
 * end-of-input reporting and a more restrictive definition of a line.
 *
 * This class supports only charsets that encode '\r' and '\n' as a single byte with value 13
 * and 10, respectively, and the representation of no other character contains these values.
 * We currently check in the constructor that the charset is US-ASCII.
 */
export class StrictLineReader implements Closeable {
  private readonly charset: Charset;

  /*
   * Buffered data is stored in `buf`. As long as no exception occurs, 0 <= pos <= end
   * and the data in the range [pos, end) is buffered for reading. At end of input, if there is
   * an unterminated line, we set end == -1, otherwise end == pos. If the underlying
   * InputStream throws an IOException, end may remain as either pos or -1.
   */
  private buf: Buffer | null;
  private pos = 0;
  private end = 0;

  /**
   * Constructs a new line reader.
   *
   * @param inputStream the stream to read data from.
   * @param capacity the capacity of the buffer.
   * @param charset the charset used to decode data. Only US-ASCII is supported.
   * @throws IllegalArgumentException if `capacity` is negative
   * or the specified charset is not supported.
   */
  constructor(
    private readonly inputStream: InputStream,
    capacity: number = DEFAULT_CAPACITY,
    charset: Charset = US_ASCII,
  ) {
    if (capacity < 0) {
      throw new IllegalArgumentException('capacity <= 0');
    }
    if (charset.name !== US_ASCII.name) {
      throw new IllegalArgumentException('Unsupported encoding');
    }

    this.charset = charset;
    this.buf = Buffer.allocUnsafe(capacity);
  }

  /**
   * Closes the reader by closing the underlying InputStream and
   * marking this reader as closed.
   *
   * @throws IOException for errors when closing the underlying InputStream.
   */
  close(): void {
    if (this.buf !== null) {
      this.buf = null;
      this.inputStream.close();
    }
  }

  /**
   * Reads the next line. A line ends with "\n" or "\r\n",
   * this end of line marker is not included in the result.
   *
   * @returns the next line from the input.
   * @throws IOException for underlying InputStream errors.
   * @throws EOFException for the end of source stream.
   */
  readLine(): string {
    const buf = this.buf;
    if (buf === null) {
      throw new IOException('LineReader is closed');
    }

    // Read more data if we are at the end of the buffered data.
    // Though it's an error to read after an exception, we will let fillBuf()
    // throw again if that happens; thus we need to handle end == -1 as well as end == pos.
    if (this.pos >= this.end) {
      this.fillBuf();
    }

    // Try to find LF in the buffered data and return the line if successful.
    for (let i = this.pos; i !== this.end; i++) {
      if (buf[i] === LF) {
        const lineEnd = i !== this.pos && buf[i - 1] === CR ? i - 1 : i;
        const result = this.charset.decode(buf, this.pos, lineEnd - this.pos);
        this.pos = i + 1;
        return result;
      }
    }

    // The line spans more than one buffer's worth of input; accumulate it.
    const pending: Buffer[] = [];
    for (;;) {
      pending.push(Buffer.from(buf.subarray(this.pos, this.end)));
      // Mark unterminated line in case fillBuf throws EOFException or IOException.
      this.end = -1;
      this.fillBuf();
      // Try to find LF in the buffered data and return the line if successful.
      for (let i = this.pos; i !== this.end; i++) {
        if (buf[i] === LF) {
          if (i !== this.pos) {
            pending.push(Buffer.from(buf.subarray(this.pos, i)));
          }
          this.pos = i + 1;
          const line = Buffer.concat(pending);
          const length =
            line.length > 0 && line[line.length - 1] === CR ? line.length - 1 : line.length;
          return this.charset.decode(line, 0, length);
        }
      }
    }
  }

  hasUnterminatedLine(): boolean {
    return this.end === -1;
  }

  /**
   * Reads new input data into the buffer. Call only with pos == end or end == -1,
   * depending on the desired outcome if the function throws.
   */
  private fillBuf(): void {
    const buf = this.buf;
    if (buf === null) {
      throw new IOException('LineReader is closed');
    }
    const result = this.inputStream.readInto(buf, 0, buf.length);
    if (result === -1) {
      throw new EOFException();
    }
    this.pos = 0;
    this.end = result;
  }
}
