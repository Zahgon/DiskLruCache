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
 * The exception types the cache raises.
 *
 * The original distinguishes these by class, not by message: `open` treats only
 * an `IOException` as "the journal is corrupt", while callers of `edit` and
 * `get` distinguish `IllegalArgumentException` from `IllegalStateException`
 * from `NullPointerException`. Collapsing them into a single `Error` would
 * erase behaviour that callers depend on, so each keeps its own class.
 */

/**
 * Carries the detail-message distinction the original relies on.
 *
 * A JVM throwable built without a message answers `null` from `getMessage()`,
 * not `""`, and the cache prints that value straight into its corruption
 * notice — a journal that ends mid-header produces
 * `"... is corrupt: null, removing"`. An `Error` whose `message` defaults to
 * `""` would print an empty gap there instead, so the two states are kept
 * apart rather than collapsed.
 *
 * Not exported: it exists to share this behaviour, and exposing it would offer
 * an `instanceof` that groups types the original keeps in separate hierarchies
 * (`IOException` under `Exception`, the rest under `RuntimeException`).
 */
abstract class Throwable extends Error {
  private readonly detailMessage: string | null;

  protected constructor(message: string | undefined, name: string) {
    super(message ?? '');
    this.name = name;
    this.detailMessage = message ?? null;
  }

  /** The detail message, or `null` if the exception was built without one. */
  getMessage(): string | null {
    return this.detailMessage;
  }
}

/** Signals that an I/O operation failed. */
export class IOException extends Throwable {
  constructor(message?: string, name = 'IOException') {
    super(message, name);
  }
}

/** Signals that the end of the input has been reached unexpectedly. */
export class EOFException extends IOException {
  constructor(message?: string) {
    super(message, 'EOFException');
  }
}

/** Signals that a file could not be opened. */
export class FileNotFoundException extends IOException {
  constructor(message?: string) {
    super(message, 'FileNotFoundException');
  }
}

/** Signals that a requested character encoding is not supported. */
export class UnsupportedEncodingException extends IOException {
  constructor(message?: string) {
    super(message, 'UnsupportedEncodingException');
  }
}

/** Signals that a method was passed an illegal or inappropriate argument. */
export class IllegalArgumentException extends Throwable {
  constructor(message?: string) {
    super(message, 'IllegalArgumentException');
  }
}

/** Signals that a method was invoked at an illegal time. */
export class IllegalStateException extends Throwable {
  constructor(message?: string) {
    super(message, 'IllegalStateException');
  }
}

/** Signals that a `null` value was used where an object is required. */
export class NullPointerException extends Throwable {
  constructor(message?: string) {
    super(message, 'NullPointerException');
  }
}

/** Signals that an iterator has no more elements. */
export class NoSuchElementException extends Throwable {
  constructor(message?: string) {
    super(message, 'NoSuchElementException');
  }
}
