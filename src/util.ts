/*
 * Copyright (C) 2010 The Android Open Source Project
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

import { US_ASCII, UTF_8 } from './internal/charset';
import { IOException } from './internal/errors';
import * as file from './internal/file';
import type { InputStream } from './internal/streams';

/** Junk drawer of utility methods. */

export { US_ASCII, UTF_8 };

/** Anything that can be closed, and whose close may fail. */
export interface Closeable {
  close(): void;
}

/** Reads the stream to exhaustion and decodes it as UTF-8, then closes it. */
export function readFully(stream: InputStream): string {
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(1024);
    for (;;) {
      const count = stream.readInto(buffer, 0, buffer.length);
      if (count === -1) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return UTF_8.decode(Buffer.concat(chunks));
  } finally {
    stream.close();
  }
}

/**
 * Deletes the contents of `dir`. Throws an IOException if any file
 * could not be deleted, or if `dir` is not a readable directory.
 */
export function deleteContents(dir: string): void {
  const files = file.listFiles(dir);
  if (files === null) {
    throw new IOException(`not a readable directory: ${dir}`);
  }
  for (const child of files) {
    if (file.isDirectory(child)) {
      deleteContents(child);
    }
    if (!file.deleteFile(child)) {
      throw new IOException(`failed to delete file: ${child}`);
    }
  }
}

/**
 * Closes `closeable`, swallowing an I/O failure.
 *
 * The original rethrows `RuntimeException` and swallows only checked
 * exceptions, so a programming error still surfaces while a failure to close a
 * file the caller is done with does not. `IOException` is the checked case here.
 */
export function closeQuietly(closeable: Closeable | null): void {
  if (closeable !== null) {
    try {
      closeable.close();
    } catch (error) {
      if (!(error instanceof IOException)) {
        throw error;
      }
    }
  }
}
