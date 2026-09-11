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
import * as path from 'node:path';

/**
 * The subset of `java.io.File` the cache uses, over Node's `fs`.
 *
 * The cache is written against a filesystem API that *reports* failure rather
 * than throwing: `delete()` and `renameTo()` return booleans, and `length()`
 * answers `0` for a file that is not there. It relies on that — a missing file
 * during eviction or an aggressive external `rm -rf` must not blow up mid-edit.
 * Node throws for all three, so each is wrapped rather than used directly.
 *
 * A file is identified by its path string, which is also what the original
 * interpolates into its error messages via `File.toString()`.
 */

/** Resolves a child of `directory`, as `new File(directory, name)` does. */
export function resolve(directory: string, name: string): string {
  return path.join(directory, name);
}

/** True if the file or directory exists. */
export function exists(file: string): boolean {
  return fs.existsSync(file);
}

/** True if the path exists and is a directory. */
export function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Deletes a file or an empty directory, answering whether it went away —
 * `java.io.File.delete()`, which reports failure instead of throwing.
 */
export function deleteFile(file: string): boolean {
  try {
    if (isDirectory(file)) {
      fs.rmdirSync(file);
    } else {
      fs.unlinkSync(file);
    }
    return true;
  } catch {
    return false;
  }
}

/** Renames `from` to `to`, answering whether it worked. */
export function renameTo(from: string, to: string): boolean {
  try {
    fs.renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/** The length of the file in bytes, or `0` if it does not exist. */
export function length(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * The paths of the directory's children, or `null` if it is not a readable
 * directory — the `null` return is how the caller detects that case.
 */
export function listFiles(directory: string): string[] | null {
  try {
    return fs.readdirSync(directory).map((name) => path.join(directory, name));
  } catch {
    return null;
  }
}

/** Creates the directory and any missing parents. */
export function mkdirs(directory: string): boolean {
  try {
    fs.mkdirSync(directory, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
