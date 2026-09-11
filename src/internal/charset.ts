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
 * The two character encodings the cache uses: US-ASCII for the journal and
 * UTF-8 for entry values.
 *
 * Node's built-in `'ascii'` encoding is *not* US-ASCII — it masks the high bit
 * (`byte & 0x7f`) in both directions, so it would silently turn a stray `0xc3`
 * into `'C'`. The JDK maps an un-encodable character to `'?'` on the way out
 * and an out-of-range byte to `U+FFFD` on the way in. The journal is ASCII by
 * construction, but reproducing the JDK's replacement behaviour is what makes a
 * corrupt journal fail the same way in both implementations.
 */

const REPLACEMENT_CHAR = '�';
const QUESTION_MARK = 0x3f;

/** A character encoding, named as the JDK names it. */
export interface Charset {
  readonly name: string;
  encode(text: string): Buffer;
  decode(bytes: Buffer, offset?: number, length?: number): string;
}

export const US_ASCII: Charset = {
  name: 'US-ASCII',

  encode(text: string): Buffer {
    const bytes = Buffer.allocUnsafe(text.length);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      bytes[i] = code <= 0x7f ? code : QUESTION_MARK;
    }
    return bytes;
  },

  decode(bytes: Buffer, offset = 0, length = bytes.length - offset): string {
    let text = '';
    for (let i = offset; i < offset + length; i++) {
      const byte = bytes[i] as number;
      text += byte <= 0x7f ? String.fromCharCode(byte) : REPLACEMENT_CHAR;
    }
    return text;
  },
};

export const UTF_8: Charset = {
  name: 'UTF-8',

  encode(text: string): Buffer {
    return Buffer.from(text, 'utf8');
  },

  decode(bytes: Buffer, offset = 0, length = bytes.length - offset): string {
    return bytes.toString('utf8', offset, offset + length);
  },
};
