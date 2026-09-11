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

/** Signals that a string could not be parsed as a number. */
export class NumberFormatException extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'NumberFormatException';
  }
}

const DECIMAL = /^[+-]?[0-9]+$/;

/** The bounds of Java's `long`, which is what the journal's lengths are. */
const LONG_MIN_VALUE = -(2n ** 63n);
const LONG_MAX_VALUE = 2n ** 63n - 1n;

/**
 * Parses a signed decimal integer, as `Long.parseLong` does.
 *
 * `Number()` will not do: it accepts hexadecimal (`"0x10"` → 16), exponents,
 * whitespace padding and the empty string (→ 0), every one of which
 * `Long.parseLong` rejects. Those strings reach here straight out of a journal
 * file, where a lax parse would turn a corrupt `CLEAN` line into a plausible
 * value length and desynchronise the cache's size accounting instead of
 * triggering the rebuild the original performs.
 *
 * Digits alone are not sufficient either. `Long.parseLong` also rejects values
 * outside the `long` range, while `Number()` answers an imprecise float for
 * them without complaint — so an absurd length in a `CLEAN` line would be
 * adopted as the entry's size rather than condemning the journal. The range is
 * checked with `BigInt` so the comparison itself does not lose precision.
 *
 * Values above `Number.MAX_SAFE_INTEGER` but within `long` range are still
 * narrowed on return; a single cache value would have to exceed 8 petabytes to
 * reach that, and the original documents a value as capped at `Integer.MAX_VALUE`.
 */
export function parseLong(text: string): number {
  if (!DECIMAL.test(text)) {
    throw new NumberFormatException(`For input string: "${text}"`);
  }
  const value = BigInt(text);
  if (value < LONG_MIN_VALUE || value > LONG_MAX_VALUE) {
    throw new NumberFormatException(`For input string: "${text}"`);
  }
  return Number(value);
}
