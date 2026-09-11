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

export {
  ANY_SEQUENCE_NUMBER,
  DiskLruCache,
  Editor,
  JOURNAL_FILE,
  JOURNAL_FILE_BACKUP,
  JOURNAL_FILE_TEMP,
  MAGIC,
  Snapshot,
  STRING_KEY_PATTERN,
  VERSION_1,
} from './diskLruCache';

export { StrictLineReader } from './strictLineReader';

export { closeQuietly, deleteContents, readFully, US_ASCII, UTF_8 } from './util';
export type { Closeable } from './util';

export { InputStream, OutputStream } from './internal/streams';

export {
  EOFException,
  FileNotFoundException,
  IllegalArgumentException,
  IllegalStateException,
  IOException,
  NoSuchElementException,
  NullPointerException,
  UnsupportedEncodingException,
} from './internal/errors';
