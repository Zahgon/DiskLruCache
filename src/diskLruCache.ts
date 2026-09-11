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

import { US_ASCII, UTF_8 } from './internal/charset';
import {
  EOFException,
  FileNotFoundException,
  IllegalArgumentException,
  IllegalStateException,
  IOException,
  NullPointerException,
} from './internal/errors';
import { SerialExecutor } from './internal/executor';
import * as file from './internal/file';
import { AccessOrderedMap } from './internal/linkedHashMap';
import { NumberFormatException, parseLong } from './internal/parseLong';
import {
  FileInputStream,
  FileOutputStream,
  InputStream,
  NullOutputStream,
  OutputStream,
} from './internal/streams';
import type { Writer } from './internal/writer';
import { BufferedWriter, OutputStreamWriter } from './internal/writer';
import { StrictLineReader } from './strictLineReader';
import type { Closeable } from './util';
import { closeQuietly, deleteContents, readFully } from './util';

export const JOURNAL_FILE = 'journal';
export const JOURNAL_FILE_TEMP = 'journal.tmp';
export const JOURNAL_FILE_BACKUP = 'journal.bkp';
export const MAGIC = 'libcore.io.DiskLruCache';
export const VERSION_1 = '1';
export const ANY_SEQUENCE_NUMBER = -1;
export const STRING_KEY_PATTERN = '[a-z0-9_-]{1,120}';

const LEGAL_KEY_PATTERN = /^[a-z0-9_-]{1,120}$/;

const CLEAN = 'CLEAN';
const DIRTY = 'DIRTY';
const REMOVE = 'REMOVE';
const READ = 'READ';

const REDUNDANT_OP_COMPACT_THRESHOLD = 2000;

/*
 * This cache uses a journal file named "journal". A typical journal file
 * looks like this:
 *     libcore.io.DiskLruCache
 *     1
 *     100
 *     2
 *
 *     CLEAN 3400330d1dfc7f3f7f4b8d4d803dfcf6 832 21054
 *     DIRTY 335c4c6028171cfddfbaae1a9c313c52
 *     CLEAN 335c4c6028171cfddfbaae1a9c313c52 3934 2342
 *     REMOVE 335c4c6028171cfddfbaae1a9c313c52
 *     DIRTY 1ab96a171faeeee38496d8b330771a7a
 *     CLEAN 1ab96a171faeeee38496d8b330771a7a 1600 234
 *     READ 335c4c6028171cfddfbaae1a9c313c52
 *     READ 3400330d1dfc7f3f7f4b8d4d803dfcf6
 *
 * The first five lines of the journal form its header. They are the
 * constant string "libcore.io.DiskLruCache", the disk cache's version,
 * the application's version, the value count, and a blank line.
 *
 * Each of the subsequent lines in the file is a record of the state of a
 * cache entry. Each line contains space-separated values: a state, a key,
 * and optional state-specific values.
 *   o DIRTY lines track that an entry is actively being created or updated.
 *     Every successful DIRTY action should be followed by a CLEAN or REMOVE
 *     action. DIRTY lines without a matching CLEAN or REMOVE indicate that
 *     temporary files may need to be deleted.
 *   o CLEAN lines track a cache entry that has been successfully published
 *     and may be read. A publish line is followed by the lengths of each of
 *     its values.
 *   o READ lines track accesses for LRU.
 *   o REMOVE lines track entries that have been deleted.
 *
 * The journal file is appended to as cache operations occur. The journal may
 * occasionally be compacted by dropping redundant lines. A temporary file named
 * "journal.tmp" will be used during compaction; that file should be deleted if
 * it exists when the cache is opened.
 */

/**
 * A cache that uses a bounded amount of space on a filesystem. Each cache
 * entry has a string key and a fixed number of values. Each key must match
 * the regex `[a-z0-9_-]{1,120}`. Values are byte sequences, accessible as
 * streams or files.
 *
 * The cache stores its data in a directory on the filesystem. This
 * directory must be exclusive to the cache; the cache may delete or overwrite
 * files from its directory. It is an error for multiple processes to use the
 * same cache directory at the same time.
 *
 * This cache limits the number of bytes that it will store on the
 * filesystem. When the number of stored bytes exceeds the limit, the cache will
 * remove entries in the background until the limit is satisfied. The limit is
 * not strict: the cache may temporarily exceed it while waiting for files to be
 * deleted. The limit does not include filesystem overhead or the cache
 * journal so space-sensitive applications should set a conservative limit.
 *
 * Clients call `edit` to create or update the values of an entry. An
 * entry may have only one editor at one time; if a value is not available to be
 * edited then `edit` will return null.
 *
 * - When an entry is being **created** it is necessary to supply a full set of
 *   values; the empty value should be used as a placeholder if necessary.
 * - When an entry is being **edited**, it is not necessary to supply data for
 *   every value; values default to their previous value.
 *
 * Every `edit` call must be matched by a call to `Editor.commit` or
 * `Editor.abort`. Committing is atomic: a read observes the full set of values
 * as they were before or after the commit, but never a mix of values.
 *
 * Clients call `get` to read a snapshot of an entry. The read will observe the
 * value at the time that `get` was called. Updates and removals after the call
 * do not impact ongoing reads.
 *
 * This class is tolerant of some I/O errors. If files are missing from the
 * filesystem, the corresponding entries will be dropped from the cache. If
 * an error occurs while writing a cache value, the edit will fail silently.
 * Callers should handle other problems by catching `IOException` and
 * responding appropriately.
 */
export class DiskLruCache implements Closeable {
  private readonly journalFile: string;
  private readonly journalFileTmp: string;
  private readonly journalFileBackup: string;
  private currentSize = 0;
  private journalWriter: Writer | null = null;
  private readonly lruEntries = new AccessOrderedMap<string, Entry>();
  private redundantOpCount = 0;

  /**
   * To differentiate between old and current snapshots, each entry is given
   * a sequence number each time an edit is committed. A snapshot is stale if
   * its sequence number is not equal to its entry's sequence number.
   */
  private nextSequenceNumber = 0;

  /** This cache uses a single background worker to evict entries. */
  readonly executorService = new SerialExecutor();

  private readonly cleanupCallable = (): void => {
    if (this.journalWriter === null) {
      return; // Closed.
    }
    this.trimToSize();
    if (this.journalRebuildRequired()) {
      this.rebuildJournal();
      this.redundantOpCount = 0;
    }
  };

  private constructor(
    private readonly directory: string,
    private readonly appVersion: number,
    /** @internal */ readonly valueCount: number,
    private maxSize: number,
  ) {
    this.journalFile = file.resolve(directory, JOURNAL_FILE);
    this.journalFileTmp = file.resolve(directory, JOURNAL_FILE_TEMP);
    this.journalFileBackup = file.resolve(directory, JOURNAL_FILE_BACKUP);
  }

  /**
   * Opens the cache in `directory`, creating a cache if none exists there.
   *
   * @param directory a writable directory
   * @param valueCount the number of values per cache entry. Must be positive.
   * @param maxSize the maximum number of bytes this cache should use to store
   * @throws IOException if reading or writing the cache directory fails
   */
  static open(
    directory: string,
    appVersion: number,
    valueCount: number,
    maxSize: number,
  ): DiskLruCache {
    if (maxSize <= 0) {
      throw new IllegalArgumentException('maxSize <= 0');
    }
    if (valueCount <= 0) {
      throw new IllegalArgumentException('valueCount <= 0');
    }

    // If a bkp file exists, use it instead.
    const backupFile = file.resolve(directory, JOURNAL_FILE_BACKUP);
    if (file.exists(backupFile)) {
      const journalFile = file.resolve(directory, JOURNAL_FILE);
      // If journal file also exists just delete backup file.
      if (file.exists(journalFile)) {
        file.deleteFile(backupFile);
      } else {
        renameTo(backupFile, journalFile, false);
      }
    }

    // Prefer to pick up where we left off.
    let cache = new DiskLruCache(directory, appVersion, valueCount, maxSize);
    if (file.exists(cache.journalFile)) {
      try {
        cache.readJournal();
        cache.processJournal();
        return cache;
      } catch (journalIsCorrupt) {
        if (!(journalIsCorrupt instanceof IOException)) {
          throw journalIsCorrupt;
        }
        // A journal that ends mid-header raises an EOFException carrying no
        // message, and the original prints the null straight through.
        const reason = journalIsCorrupt.getMessage();
        console.log(
          `DiskLruCache ${directory} is corrupt: ${reason === null ? 'null' : reason}, removing`,
        );
        cache.delete();
      }
    }

    // Create a new empty cache.
    file.mkdirs(directory);
    cache = new DiskLruCache(directory, appVersion, valueCount, maxSize);
    cache.rebuildJournal();
    return cache;
  }

  private readJournal(): void {
    const reader = new StrictLineReader(new FileInputStream(this.journalFile), 8192, US_ASCII);
    try {
      const magic = reader.readLine();
      const version = reader.readLine();
      const appVersionString = reader.readLine();
      const valueCountString = reader.readLine();
      const blank = reader.readLine();
      if (
        MAGIC !== magic ||
        VERSION_1 !== version ||
        String(this.appVersion) !== appVersionString ||
        String(this.valueCount) !== valueCountString ||
        blank !== ''
      ) {
        throw new IOException(
          `unexpected journal header: [${magic}, ${version}, ${valueCountString}, ${blank}]`,
        );
      }

      let lineCount = 0;
      for (;;) {
        try {
          this.readJournalLine(reader.readLine());
          lineCount++;
        } catch (endOfJournal) {
          if (endOfJournal instanceof EOFException) {
            break;
          }
          throw endOfJournal;
        }
      }
      this.redundantOpCount = lineCount - this.lruEntries.size;

      // If we ended on a truncated line, rebuild the journal before appending to it.
      if (reader.hasUnterminatedLine()) {
        this.rebuildJournal();
      } else {
        this.journalWriter = new BufferedWriter(
          new OutputStreamWriter(new FileOutputStream(this.journalFile, true), US_ASCII),
        );
      }
    } finally {
      closeQuietly(reader);
    }
  }

  private readJournalLine(line: string): void {
    const firstSpace = line.indexOf(' ');
    if (firstSpace === -1) {
      throw new IOException(`unexpected journal line: ${line}`);
    }

    const keyBegin = firstSpace + 1;
    const secondSpace = line.indexOf(' ', keyBegin);
    let key: string;
    if (secondSpace === -1) {
      key = line.substring(keyBegin);
      if (firstSpace === REMOVE.length && line.startsWith(REMOVE)) {
        this.lruEntries.remove(key);
        return;
      }
    } else {
      key = line.substring(keyBegin, secondSpace);
    }

    let entry = this.lruEntries.get(key);
    if (entry === null) {
      entry = new Entry(this, key);
      this.lruEntries.put(key, entry);
    }

    if (secondSpace !== -1 && firstSpace === CLEAN.length && line.startsWith(CLEAN)) {
      const parts = splitOnSpace(line.substring(secondSpace + 1));
      entry.readable = true;
      entry.currentEditor = null;
      entry.setLengths(parts);
    } else if (secondSpace === -1 && firstSpace === DIRTY.length && line.startsWith(DIRTY)) {
      entry.currentEditor = new Editor(this, entry);
    } else if (secondSpace === -1 && firstSpace === READ.length && line.startsWith(READ)) {
      // This work was already done by calling lruEntries.get().
    } else {
      throw new IOException(`unexpected journal line: ${line}`);
    }
  }

  /**
   * Computes the initial size and collects garbage as a part of opening the
   * cache. Dirty entries are assumed to be inconsistent and will be deleted.
   */
  private processJournal(): void {
    deleteIfExists(this.journalFileTmp);
    for (const entry of this.lruEntries.values()) {
      if (entry.currentEditor === null) {
        for (const length of entry.lengths) {
          this.currentSize += length;
        }
      } else {
        entry.currentEditor = null;
        for (let t = 0; t < this.valueCount; t++) {
          deleteIfExists(entry.getCleanFile(t));
          deleteIfExists(entry.getDirtyFile(t));
        }
        this.lruEntries.remove(entry.key);
      }
    }
  }

  /**
   * Creates a new journal that omits redundant information. This replaces the
   * current journal if it exists.
   */
  private rebuildJournal(): void {
    if (this.journalWriter !== null) {
      this.journalWriter.close();
    }

    const writer: Writer = new BufferedWriter(
      new OutputStreamWriter(new FileOutputStream(this.journalFileTmp), US_ASCII),
    );
    try {
      writer.write(MAGIC);
      writer.write('\n');
      writer.write(VERSION_1);
      writer.write('\n');
      writer.write(String(this.appVersion));
      writer.write('\n');
      writer.write(String(this.valueCount));
      writer.write('\n');
      writer.write('\n');

      for (const entry of this.lruEntries.values()) {
        if (entry.currentEditor !== null) {
          writer.write(`${DIRTY} ${entry.key}\n`);
        } else {
          writer.write(`${CLEAN} ${entry.key}${entry.getLengths()}\n`);
        }
      }
    } finally {
      writer.close();
    }

    if (file.exists(this.journalFile)) {
      renameTo(this.journalFile, this.journalFileBackup, true);
    }
    renameTo(this.journalFileTmp, this.journalFile, false);
    file.deleteFile(this.journalFileBackup);

    this.journalWriter = new BufferedWriter(
      new OutputStreamWriter(new FileOutputStream(this.journalFile, true), US_ASCII),
    );
  }

  /**
   * Returns a snapshot of the entry named `key`, or null if it doesn't
   * exist is not currently readable. If a value is returned, it is moved to
   * the head of the LRU queue.
   */
  get(key: string): Snapshot | null {
    this.checkNotClosed();
    validateKey(key);
    const entry = this.lruEntries.get(key);
    if (entry === null) {
      return null;
    }

    if (!entry.readable) {
      return null;
    }

    // Open all streams eagerly to guarantee that we see a single published
    // snapshot. If we opened streams lazily then the streams could come
    // from different edits.
    const ins: (InputStream | null)[] = new Array<InputStream | null>(this.valueCount).fill(null);
    try {
      for (let i = 0; i < this.valueCount; i++) {
        ins[i] = new FileInputStream(entry.getCleanFile(i));
      }
    } catch (e) {
      if (!(e instanceof FileNotFoundException)) {
        throw e;
      }
      // A file must have been deleted manually!
      for (let i = 0; i < this.valueCount; i++) {
        const stream = ins[i];
        if (stream !== null && stream !== undefined) {
          closeQuietly(stream);
        } else {
          break;
        }
      }
      return null;
    }

    this.redundantOpCount++;
    this.journal().write(`${READ} ${key}\n`);
    if (this.journalRebuildRequired()) {
      this.executorService.submit(this.cleanupCallable);
    }

    return new Snapshot(this, key, entry.sequenceNumber, ins as InputStream[], entry.lengths);
  }

  /**
   * Returns an editor for the entry named `key`, or null if another
   * edit is in progress.
   */
  edit(key: string): Editor | null {
    return this.editEntry(key, ANY_SEQUENCE_NUMBER);
  }

  /** @internal */
  editEntry(key: string, expectedSequenceNumber: number): Editor | null {
    this.checkNotClosed();
    validateKey(key);
    let entry = this.lruEntries.get(key);
    if (
      expectedSequenceNumber !== ANY_SEQUENCE_NUMBER &&
      (entry === null || entry.sequenceNumber !== expectedSequenceNumber)
    ) {
      return null; // Snapshot is stale.
    }
    if (entry === null) {
      entry = new Entry(this, key);
      this.lruEntries.put(key, entry);
    } else if (entry.currentEditor !== null) {
      return null; // Another edit is in progress.
    }

    const editor = new Editor(this, entry);
    entry.currentEditor = editor;

    // Flush the journal before creating files to prevent file leaks.
    const journal = this.journal();
    journal.write(`${DIRTY} ${key}\n`);
    journal.flush();
    return editor;
  }

  /** Returns the directory where this cache stores its data. */
  getDirectory(): string {
    return this.directory;
  }

  /**
   * Returns the maximum number of bytes that this cache should use to store
   * its data.
   */
  getMaxSize(): number {
    return this.maxSize;
  }

  /**
   * Changes the maximum number of bytes the cache can store and queues a job
   * to trim the existing store, if necessary.
   */
  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;
    this.executorService.submit(this.cleanupCallable);
  }

  /**
   * Returns the number of bytes currently being used to store the values in
   * this cache. This may be greater than the max size if a background
   * deletion is pending.
   */
  size(): number {
    return this.currentSize;
  }

  /** @internal */
  completeEdit(editor: Editor, success: boolean): void {
    const entry = editor.entry;
    if (entry.currentEditor !== editor) {
      throw new IllegalStateException();
    }

    // If this edit is creating the entry for the first time, every index must have a value.
    if (success && !entry.readable) {
      for (let i = 0; i < this.valueCount; i++) {
        if (editor.written === null || editor.written[i] !== true) {
          editor.abort();
          throw new IllegalStateException(
            `Newly created entry didn't create value for index ${i}`,
          );
        }
        if (!file.exists(entry.getDirtyFile(i))) {
          editor.abort();
          return;
        }
      }
    }

    for (let i = 0; i < this.valueCount; i++) {
      const dirty = entry.getDirtyFile(i);
      if (success) {
        if (file.exists(dirty)) {
          const clean = entry.getCleanFile(i);
          file.renameTo(dirty, clean);
          const oldLength = entry.lengths[i] as number;
          const newLength = file.length(clean);
          entry.lengths[i] = newLength;
          this.currentSize = this.currentSize - oldLength + newLength;
        }
      } else {
        deleteIfExists(dirty);
      }
    }

    this.redundantOpCount++;
    entry.currentEditor = null;
    const journal = this.journal();
    if (entry.readable || success) {
      entry.readable = true;
      journal.write(`${CLEAN} ${entry.key}${entry.getLengths()}\n`);
      if (success) {
        entry.sequenceNumber = this.nextSequenceNumber++;
      }
    } else {
      this.lruEntries.remove(entry.key);
      journal.write(`${REMOVE} ${entry.key}\n`);
    }
    journal.flush();

    if (this.currentSize > this.maxSize || this.journalRebuildRequired()) {
      this.executorService.submit(this.cleanupCallable);
    }
  }

  /**
   * We only rebuild the journal when it will halve the size of the journal
   * and eliminate at least 2000 ops.
   */
  private journalRebuildRequired(): boolean {
    return (
      this.redundantOpCount >= REDUNDANT_OP_COMPACT_THRESHOLD &&
      this.redundantOpCount >= this.lruEntries.size
    );
  }

  /**
   * Drops the entry for `key` if it exists and can be removed. Entries
   * actively being edited cannot be removed.
   *
   * @returns true if an entry was removed.
   */
  remove(key: string): boolean {
    this.checkNotClosed();
    validateKey(key);
    const entry = this.lruEntries.get(key);
    if (entry === null || entry.currentEditor !== null) {
      return false;
    }

    for (let i = 0; i < this.valueCount; i++) {
      const target = entry.getCleanFile(i);
      if (file.exists(target) && !file.deleteFile(target)) {
        throw new IOException(`failed to delete ${target}`);
      }
      this.currentSize -= entry.lengths[i] as number;
      entry.lengths[i] = 0;
    }

    this.redundantOpCount++;
    this.journal().write(`${REMOVE} ${key}\n`);
    this.lruEntries.remove(key);

    if (this.journalRebuildRequired()) {
      this.executorService.submit(this.cleanupCallable);
    }

    return true;
  }

  /** Returns true if this cache has been closed. */
  isClosed(): boolean {
    return this.journalWriter === null;
  }

  private checkNotClosed(): void {
    if (this.journalWriter === null) {
      throw new IllegalStateException('cache is closed');
    }
  }

  /**
   * The journal writer, which the original dereferences without a null check —
   * a closed cache throws a NullPointerException there rather than the
   * IllegalStateException that `checkNotClosed` produces.
   */
  private journal(): Writer {
    if (this.journalWriter === null) {
      throw new NullPointerException();
    }
    return this.journalWriter;
  }

  /** Force buffered operations to the filesystem. */
  flush(): void {
    this.checkNotClosed();
    this.trimToSize();
    this.journal().flush();
  }

  /** Closes this cache. Stored values will remain on the filesystem. */
  close(): void {
    if (this.journalWriter === null) {
      return; // Already closed.
    }
    for (const entry of this.lruEntries.values()) {
      if (entry.currentEditor !== null) {
        entry.currentEditor.abort();
      }
    }
    this.trimToSize();
    this.journalWriter.close();
    this.journalWriter = null;
  }

  private trimToSize(): void {
    while (this.currentSize > this.maxSize) {
      this.remove(this.lruEntries.eldestKey());
    }
  }

  /**
   * Closes the cache and deletes all of its stored values. This will delete
   * all files in the cache directory including files that weren't created by
   * the cache.
   */
  delete(): void {
    this.close();
    deleteContents(this.directory);
  }
}

/** A snapshot of the values for an entry. */
export class Snapshot implements Closeable {
  /** @internal */
  constructor(
    private readonly cache: DiskLruCache,
    private readonly key: string,
    private readonly sequenceNumber: number,
    private readonly ins: InputStream[],
    private readonly lengths: number[],
  ) {}

  /**
   * Returns an editor for this snapshot's entry, or null if either the
   * entry has changed since this snapshot was created or if another edit
   * is in progress.
   */
  edit(): Editor | null {
    return this.cache.editEntry(this.key, this.sequenceNumber);
  }

  /** Returns the unbuffered stream with the value for `index`. */
  getInputStream(index: number): InputStream {
    return this.ins[index] as InputStream;
  }

  /** Returns the string value for `index`. */
  getString(index: number): string {
    return readFully(this.getInputStream(index));
  }

  /** Returns the byte length of the value for `index`. */
  getLength(index: number): number {
    return this.lengths[index] as number;
  }

  close(): void {
    for (const stream of this.ins) {
      closeQuietly(stream);
    }
  }
}

/** Edits the values for an entry. */
export class Editor {
  /** @internal */ readonly written: boolean[] | null;
  /** @internal */ hasErrors = false;
  private committed = false;

  /** @internal */
  constructor(
    private readonly cache: DiskLruCache,
    /** @internal */ readonly entry: Entry,
  ) {
    this.written = entry.readable
      ? null
      : new Array<boolean>(cache.valueCount).fill(false);
  }

  /**
   * Returns an unbuffered input stream to read the last committed value,
   * or null if no value has been committed.
   */
  newInputStream(index: number): InputStream | null {
    if (this.entry.currentEditor !== this) {
      throw new IllegalStateException();
    }
    if (!this.entry.readable) {
      return null;
    }
    try {
      return new FileInputStream(this.entry.getCleanFile(index));
    } catch (e) {
      if (!(e instanceof FileNotFoundException)) {
        throw e;
      }
      return null;
    }
  }

  /**
   * Returns the last committed value as a string, or null if no value
   * has been committed.
   */
  getString(index: number): string | null {
    const stream = this.newInputStream(index);
    return stream !== null ? readFully(stream) : null;
  }

  /**
   * Returns a new unbuffered output stream to write the value at
   * `index`. If the underlying output stream encounters errors
   * when writing to the filesystem, this edit will be aborted when
   * `commit` is called. The returned output stream does not throw
   * IOExceptions.
   */
  newOutputStream(index: number): OutputStream {
    if (index < 0 || index >= this.cache.valueCount) {
      throw new IllegalArgumentException(
        `Expected index ${index} to be greater than 0 and less than the maximum value count ` +
          `of ${this.cache.valueCount}`,
      );
    }
    if (this.entry.currentEditor !== this) {
      throw new IllegalStateException();
    }
    if (!this.entry.readable && this.written !== null) {
      this.written[index] = true;
    }
    const dirtyFile = this.entry.getDirtyFile(index);
    let outputStream: OutputStream;
    try {
      outputStream = new FileOutputStream(dirtyFile);
    } catch (e) {
      if (!(e instanceof FileNotFoundException)) {
        throw e;
      }
      // Attempt to recreate the cache directory.
      file.mkdirs(this.cache.getDirectory());
      try {
        outputStream = new FileOutputStream(dirtyFile);
      } catch (e2) {
        if (!(e2 instanceof FileNotFoundException)) {
          throw e2;
        }
        // We are unable to recover. Silently eat the writes.
        return new NullOutputStream();
      }
    }
    return new FaultHidingOutputStream(this, outputStream);
  }

  /** Sets the value at `index` to `value`. */
  set(index: number, value: string): void {
    let writer: Writer | null = null;
    try {
      writer = new OutputStreamWriter(this.newOutputStream(index), UTF_8);
      writer.write(value);
    } finally {
      closeQuietly(writer);
    }
  }

  /**
   * Commits this edit so it is visible to readers. This releases the
   * edit lock so another edit may be started on the same key.
   */
  commit(): void {
    if (this.hasErrors) {
      this.cache.completeEdit(this, false);
      this.cache.remove(this.entry.key); // The previous entry is stale.
    } else {
      this.cache.completeEdit(this, true);
    }
    this.committed = true;
  }

  /**
   * Aborts this edit. This releases the edit lock so another edit may be
   * started on the same key.
   */
  abort(): void {
    this.cache.completeEdit(this, false);
  }

  abortUnlessCommitted(): void {
    if (!this.committed) {
      try {
        this.abort();
      } catch (ignored) {
        if (!(ignored instanceof IOException)) {
          throw ignored;
        }
      }
    }
  }
}

/**
 * An output stream that records write failures on its editor instead of
 * raising them, so that a failed write aborts the edit at commit time rather
 * than propagating out of an unrelated `set` call.
 */
class FaultHidingOutputStream extends OutputStream {
  constructor(
    private readonly editor: Editor,
    private readonly out: OutputStream,
  ) {
    super();
  }

  override write(oneByte: number): void {
    try {
      this.out.write(oneByte);
    } catch (e) {
      if (!(e instanceof IOException)) {
        throw e;
      }
      this.editor.hasErrors = true;
    }
  }

  override writeFrom(buffer: Buffer, offset: number, length: number): void {
    try {
      this.out.writeFrom(buffer, offset, length);
    } catch (e) {
      if (!(e instanceof IOException)) {
        throw e;
      }
      this.editor.hasErrors = true;
    }
  }

  override close(): void {
    try {
      this.out.close();
    } catch (e) {
      if (!(e instanceof IOException)) {
        throw e;
      }
      this.editor.hasErrors = true;
    }
  }

  override flush(): void {
    try {
      this.out.flush();
    } catch (e) {
      if (!(e instanceof IOException)) {
        throw e;
      }
      this.editor.hasErrors = true;
    }
  }
}

/** @internal */
export class Entry {
  /** Lengths of this entry's files. */
  readonly lengths: number[];

  /** True if this entry has ever been published. */
  readable = false;

  /** The ongoing edit or null if this entry is not being edited. */
  currentEditor: Editor | null = null;

  /** The sequence number of the most recently committed edit to this entry. */
  sequenceNumber = 0;

  constructor(
    private readonly cache: DiskLruCache,
    readonly key: string,
  ) {
    this.lengths = new Array<number>(cache.valueCount).fill(0);
  }

  getLengths(): string {
    let result = '';
    for (const size of this.lengths) {
      result += ` ${size}`;
    }
    return result;
  }

  /** Set lengths using decimal numbers like "10123". */
  setLengths(strings: string[]): void {
    if (strings.length !== this.cache.valueCount) {
      throw invalidLengths(strings);
    }

    try {
      for (let i = 0; i < strings.length; i++) {
        this.lengths[i] = parseLong(strings[i] as string);
      }
    } catch (e) {
      if (!(e instanceof NumberFormatException)) {
        throw e;
      }
      throw invalidLengths(strings);
    }
  }

  getCleanFile(i: number): string {
    return file.resolve(this.cache.getDirectory(), `${this.key}.${i}`);
  }

  getDirtyFile(i: number): string {
    return file.resolve(this.cache.getDirectory(), `${this.key}.${i}.tmp`);
  }
}

/**
 * Splits on `' '` the way `String.split(" ")` does.
 *
 * Java's single-argument `split` uses limit 0, which discards *trailing* empty
 * strings while keeping interior ones. `"1 1 ".split(" ")` is therefore
 * `["1", "1"]` on the JVM but `["1", "1", ""]` in JavaScript, and that extra
 * element fails the value-count check — turning a journal the original reads
 * without complaint into one this implementation calls corrupt, which deletes
 * the cache directory. When no separator is present at all, Java returns the
 * whole input as a single element rather than an empty array, so `""` maps to
 * `[""]` in both.
 */
function splitOnSpace(text: string): string[] {
  const parts = text.split(' ');
  if (parts.length === 1) {
    return parts; // No separator found; Java answers the input unchanged.
  }
  let size = parts.length;
  while (size > 0 && parts[size - 1] === '') {
    size--;
  }
  return parts.slice(0, size);
}

function invalidLengths(strings: string[]): IOException {
  return new IOException(`unexpected journal line: [${strings.join(', ')}]`);
}

function deleteIfExists(target: string): void {
  if (file.exists(target) && !file.deleteFile(target)) {
    throw new IOException();
  }
}

function renameTo(from: string, to: string, deleteDestination: boolean): void {
  if (deleteDestination) {
    deleteIfExists(to);
  }
  if (!file.renameTo(from, to)) {
    throw new IOException();
  }
}

function validateKey(key: string): void {
  // Untyped JavaScript callers can still reach here with null, and the original
  // raises for it rather than matching the key regex against "null".
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (key === null || key === undefined) {
    throw new NullPointerException();
  }
  if (!LEGAL_KEY_PATTERN.test(key)) {
    throw new IllegalArgumentException(
      `keys must match regex ${STRING_KEY_PATTERN}: "${key}"`,
    );
  }
}
