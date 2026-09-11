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

import { describe, expect, test } from 'vitest';

import { US_ASCII } from '../src/internal/charset';
import { EOFException } from '../src/internal/errors';
import { InputStream } from '../src/internal/streams';
import { StrictLineReader } from '../src/strictLineReader';

/** An in-memory byte source, standing in for `ByteArrayInputStream`. */
class ByteArrayInputStream extends InputStream {
  private pos = 0;

  constructor(private readonly bytes: Buffer) {
    super();
  }

  override read(): number {
    if (this.pos >= this.bytes.length) {
      return -1;
    }
    const byte = this.bytes[this.pos] as number;
    this.pos++;
    return byte;
  }

  override readInto(buffer: Buffer, offset: number, length: number): number {
    if (this.pos >= this.bytes.length) {
      return -1;
    }
    const count = Math.min(length, this.bytes.length - this.pos);
    this.bytes.copy(buffer, offset, this.pos, this.pos + count);
    this.pos += count;
    return count;
  }

  override close(): void {
    // Nothing to release.
  }
}

describe('StrictLineReaderTest', () => {
  test('lineReaderConsistencyWithReadAsciiLine', () => {
    // Testing with LineReader buffer capacity 32 to check some corner cases.
    const lineReader = new StrictLineReader(createTestInputStream(), 32, US_ASCII);
    const refStream = createTestInputStream();
    let lineCount = 0;
    for (;;) {
      let refLine: string;
      try {
        refLine = readAsciiLine(refStream);
      } catch (refEof) {
        if (!(refEof instanceof EOFException)) {
          throw refEof;
        }
        expect(() => lineReader.readLine(), "line reader didn't throw the expected EOFException.")
          .toThrow(EOFException);
        break;
      }

      let line: string;
      try {
        line = lineReader.readLine();
      } catch (eof) {
        if (!(eof instanceof EOFException)) {
          throw eof;
        }
        expect.unreachable('line reader threw EOFException too early.');
      }

      // Asserted, rather than compared behind an `if` that only fails on
      // mismatch, so every line the reference produces is a checked expectation.
      expect(line, `line ("${line}") differs from expected ("${refLine}").`).toEqual(refLine);
      lineCount++;
    }

    // The reference stream must actually have produced the fixture's lines; an
    // empty loop would otherwise satisfy every assertion above.
    expect(lineCount).toEqual(12);
    refStream.close();
    lineReader.close();
  });
});

/* XXX From libcore.io.Streams */
function readAsciiLine(input: InputStream): string {
  // TODO: support UTF-8 here instead

  let result = '';
  for (;;) {
    const c = input.read();
    if (c === -1) {
      throw new EOFException();
    } else if (c === '\n'.charCodeAt(0)) {
      break;
    }

    result += String.fromCharCode(c);
  }
  const length = result.length;
  if (length > 0 && result.charAt(length - 1) === '\r') {
    result = result.substring(0, length - 1);
  }
  return result;
}

function createTestInputStream(): InputStream {
  return new ByteArrayInputStream(
    Buffer.from(
      // Each source lines below should represent 32 bytes, until the next comment.
      '12 byte line\n18 byte line......\n' +
        'pad\nline spanning two 32-byte bu' +
        'ffers\npad......................\n' +
        'pad\nline spanning three 32-byte ' +
        'buffers and ending with LF at th' +
        'e end of a 32 byte buffer......\n' +
        'pad\nLine ending with CRLF split' +
        ' at the end of a 32-byte buffer\r' +
        '\npad...........................\n' +
        // End of 32-byte lines.
        'line ending with CRLF\r\n' +
        'this is a long line with embedded CR \r ending with CRLF and having more than ' +
        '32 characters\r\n' +
        'unterminated line - should be dropped',
      'latin1',
    ),
  );
}
