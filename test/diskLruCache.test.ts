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

import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Editor, Snapshot } from '../src/diskLruCache';
import { DiskLruCache, JOURNAL_FILE, JOURNAL_FILE_BACKUP, MAGIC, VERSION_1 } from '../src/diskLruCache';
import { IllegalArgumentException, IllegalStateException, NullPointerException } from '../src/internal/errors';
import * as FileUtils from './support/fileUtils';
import { TemporaryFolder } from './support/tempFolder';

const INTEGER_MAX_VALUE = 2147483647;

describe('DiskLruCacheTest', () => {
  const appVersion = 100;
  let cacheDir: string;
  let journalFile: string;
  let journalBkpFile: string;
  let cache: DiskLruCache;

  const tempDir = new TemporaryFolder();

  beforeEach(() => {
    tempDir.create();
    cacheDir = tempDir.newFolder('DiskLruCacheTest');
    journalFile = path.join(cacheDir, JOURNAL_FILE);
    journalBkpFile = path.join(cacheDir, JOURNAL_FILE_BACKUP);
    for (const file of FileUtils.listFiles(cacheDir)) {
      FileUtils.deleteFile(file);
    }
    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
  });

  afterEach(() => {
    cache.close();
    tempDir.delete();
  });

  test('emptyCache', () => {
    cache.close();
    assertJournalEquals();
  });

  test('validateKey', () => {
    let key: string;

    key = 'has_space ';
    expectIllegalArgument(() => cache.edit(key), key);

    key = 'has_CR\r';
    expectIllegalArgument(() => cache.edit(key), key);

    key = 'has_LF\n';
    expectIllegalArgument(() => cache.edit(key), key);

    key = 'has_invalid/';
    expectIllegalArgument(() => cache.edit(key), key);

    key = 'has_invalid☃';
    expectIllegalArgument(() => cache.edit(key), key);

    key =
      'this_is_way_too_long_this_is_way_too_long_this_is_way_too_long_' +
      'this_is_way_too_long_this_is_way_too_long_this_is_way_too_long';
    expectIllegalArgument(() => cache.edit(key), key);

    // Test valid cases.

    // Exactly 120.
    key =
      '0123456789012345678901234567890123456789012345678901234567890123456789' +
      '01234567890123456789012345678901234567890123456789';
    required(cache.edit(key)).abort();
    // Contains all valid characters.
    key = 'abcdefghijklmnopqrstuvwxyz_0123456789';
    required(cache.edit(key)).abort();
    // Contains dash.
    key = '-20384573948576';
    required(cache.edit(key)).abort();
  });

  test('writeAndReadEntry', () => {
    const creator = required(cache.edit('k1'));
    creator.set(0, 'ABC');
    creator.set(1, 'DE');
    expect(creator.getString(0)).toBeNull();
    expect(creator.newInputStream(0)).toBeNull();
    expect(creator.getString(1)).toBeNull();
    expect(creator.newInputStream(1)).toBeNull();
    creator.commit();

    const snapshot = required(cache.get('k1'));
    expect(snapshot.getString(0)).toEqual('ABC');
    expect(snapshot.getLength(0)).toEqual(3);
    expect(snapshot.getString(1)).toEqual('DE');
    expect(snapshot.getLength(1)).toEqual(2);
  });

  test('readAndWriteEntryAcrossCacheOpenAndClose', () => {
    const creator = required(cache.edit('k1'));
    creator.set(0, 'A');
    creator.set(1, 'B');
    creator.commit();
    cache.close();

    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
    const snapshot = required(cache.get('k1'));
    expect(snapshot.getString(0)).toEqual('A');
    expect(snapshot.getLength(0)).toEqual(1);
    expect(snapshot.getString(1)).toEqual('B');
    expect(snapshot.getLength(1)).toEqual(1);
    snapshot.close();
  });

  test('readAndWriteEntryWithoutProperClose', () => {
    const creator = required(cache.edit('k1'));
    creator.set(0, 'A');
    creator.set(1, 'B');
    creator.commit();

    // Simulate a dirty close of 'cache' by opening the cache directory again.
    const cache2 = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
    const snapshot = required(cache2.get('k1'));
    expect(snapshot.getString(0)).toEqual('A');
    expect(snapshot.getLength(0)).toEqual(1);
    expect(snapshot.getString(1)).toEqual('B');
    expect(snapshot.getLength(1)).toEqual(1);
    snapshot.close();
    cache2.close();
  });

  test('journalWithEditAndPublish', () => {
    const creator = required(cache.edit('k1'));
    assertJournalEquals('DIRTY k1'); // DIRTY must always be flushed.
    creator.set(0, 'AB');
    creator.set(1, 'C');
    creator.commit();
    cache.close();
    assertJournalEquals('DIRTY k1', 'CLEAN k1 2 1');
  });

  test('revertedNewFileIsRemoveInJournal', () => {
    const creator = required(cache.edit('k1'));
    assertJournalEquals('DIRTY k1'); // DIRTY must always be flushed.
    creator.set(0, 'AB');
    creator.set(1, 'C');
    creator.abort();
    cache.close();
    assertJournalEquals('DIRTY k1', 'REMOVE k1');
  });

  test('unterminatedEditIsRevertedOnClose', () => {
    cache.edit('k1');
    cache.close();
    assertJournalEquals('DIRTY k1', 'REMOVE k1');
  });

  test('journalDoesNotIncludeReadOfYetUnpublishedValue', () => {
    const creator = required(cache.edit('k1'));
    expect(cache.get('k1')).toBeNull();
    creator.set(0, 'A');
    creator.set(1, 'BC');
    creator.commit();
    cache.close();
    assertJournalEquals('DIRTY k1', 'CLEAN k1 1 2');
  });

  test('journalWithEditAndPublishAndRead', () => {
    const k1Creator = required(cache.edit('k1'));
    k1Creator.set(0, 'AB');
    k1Creator.set(1, 'C');
    k1Creator.commit();
    const k2Creator = required(cache.edit('k2'));
    k2Creator.set(0, 'DEF');
    k2Creator.set(1, 'G');
    k2Creator.commit();
    const k1Snapshot = required(cache.get('k1'));
    k1Snapshot.close();
    cache.close();
    assertJournalEquals('DIRTY k1', 'CLEAN k1 2 1', 'DIRTY k2', 'CLEAN k2 3 1', 'READ k1');
  });

  test('cannotOperateOnEditAfterPublish', () => {
    const editor = required(cache.edit('k1'));
    editor.set(0, 'A');
    editor.set(1, 'B');
    editor.commit();
    assertInoperable(editor);
  });

  test('cannotOperateOnEditAfterRevert', () => {
    const editor = required(cache.edit('k1'));
    editor.set(0, 'A');
    editor.set(1, 'B');
    editor.abort();
    assertInoperable(editor);
  });

  test('explicitRemoveAppliedToDiskImmediately', () => {
    const editor = required(cache.edit('k1'));
    editor.set(0, 'ABC');
    editor.set(1, 'B');
    editor.commit();
    const k1 = getCleanFile('k1', 0);
    expect(FileUtils.readFileToString(k1)).toEqual('ABC');
    cache.remove('k1');
    expect(FileUtils.exists(k1)).toBe(false);
  });

  /**
   * Each read sees a snapshot of the file at the time read was called.
   * This means that two reads of the same key can see different data.
   */
  test('readAndWriteOverlapsMaintainConsistency', () => {
    const v1Creator = required(cache.edit('k1'));
    v1Creator.set(0, 'AAaa');
    v1Creator.set(1, 'BBbb');
    v1Creator.commit();

    const snapshot1 = required(cache.get('k1'));
    const inV1 = snapshot1.getInputStream(0);
    expect(inV1.read()).toEqual('A'.charCodeAt(0));
    expect(inV1.read()).toEqual('A'.charCodeAt(0));

    const v1Updater = required(cache.edit('k1'));
    v1Updater.set(0, 'CCcc');
    v1Updater.set(1, 'DDdd');
    v1Updater.commit();

    const snapshot2 = required(cache.get('k1'));
    expect(snapshot2.getString(0)).toEqual('CCcc');
    expect(snapshot2.getLength(0)).toEqual(4);
    expect(snapshot2.getString(1)).toEqual('DDdd');
    expect(snapshot2.getLength(1)).toEqual(4);
    snapshot2.close();

    expect(inV1.read()).toEqual('a'.charCodeAt(0));
    expect(inV1.read()).toEqual('a'.charCodeAt(0));
    expect(snapshot1.getString(1)).toEqual('BBbb');
    expect(snapshot1.getLength(1)).toEqual(4);
    snapshot1.close();
  });

  test('openWithDirtyKeyDeletesAllFilesForThatKey', () => {
    cache.close();
    const cleanFile0 = getCleanFile('k1', 0);
    const cleanFile1 = getCleanFile('k1', 1);
    const dirtyFile0 = getDirtyFile('k1', 0);
    const dirtyFile1 = getDirtyFile('k1', 1);
    writeFile(cleanFile0, 'A');
    writeFile(cleanFile1, 'B');
    writeFile(dirtyFile0, 'C');
    writeFile(dirtyFile1, 'D');
    createJournal('CLEAN k1 1 1', 'DIRTY   k1');
    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
    expect(FileUtils.exists(cleanFile0)).toBe(false);
    expect(FileUtils.exists(cleanFile1)).toBe(false);
    expect(FileUtils.exists(dirtyFile0)).toBe(false);
    expect(FileUtils.exists(dirtyFile1)).toBe(false);
    expect(cache.get('k1')).toBeNull();
  });

  test('openWithInvalidVersionClearsDirectory', () => {
    cache.close();
    generateSomeGarbageFiles();
    createJournalWithHeader(MAGIC, '0', '100', '2', '');
    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
    assertGarbageFilesAllDeleted();
  });

  test('openWithInvalidAppVersionClearsDirectory', () => {
    cache.close();
    generateSomeGarbageFiles();
    createJournalWithHeader(MAGIC, '1', '101', '2', '');
    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
    assertGarbageFilesAllDeleted();
  });

  test('openWithInvalidValueCountClearsDirectory', () => {
    cache.close();
    generateSomeGarbageFiles();
    createJournalWithHeader(MAGIC, '1', '100', '1', '');
    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
    assertGarbageFilesAllDeleted();
  });

  test('openWithInvalidBlankLineClearsDirectory', () => {
    cache.close();
    generateSomeGarbageFiles();
    createJournalWithHeader(MAGIC, '1', '100', '2', 'x');
    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
    assertGarbageFilesAllDeleted();
  });

  test('openWithInvalidJournalLineClearsDirectory', () => {
    cache.close();
    generateSomeGarbageFiles();
    createJournal('CLEAN k1 1 1', 'BOGUS');
    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
    assertGarbageFilesAllDeleted();
    expect(cache.get('k1')).toBeNull();
  });

  test('openWithInvalidFileSizeClearsDirectory', () => {
    cache.close();
    generateSomeGarbageFiles();
    createJournal('CLEAN k1 0000x001 1');
    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
    assertGarbageFilesAllDeleted();
    expect(cache.get('k1')).toBeNull();
  });

  test('openWithTruncatedLineDiscardsThatLine', () => {
    cache.close();
    writeFile(getCleanFile('k1', 0), 'A');
    writeFile(getCleanFile('k1', 1), 'B');
    // no trailing newline
    FileUtils.writeStringToFile(journalFile, `${MAGIC}\n${VERSION_1}\n100\n2\n\nCLEAN k1 1 1`);
    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
    expect(cache.get('k1')).toBeNull();

    // The journal is not corrupt when editing after a truncated line.
    set('k1', 'C', 'D');
    cache.close();
    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
    assertValue('k1', 'C', 'D');
  });

  test('openWithTooManyFileSizesClearsDirectory', () => {
    cache.close();
    generateSomeGarbageFiles();
    createJournal('CLEAN k1 1 1 1');
    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
    assertGarbageFilesAllDeleted();
    expect(cache.get('k1')).toBeNull();
  });

  test('keyWithSpaceNotPermitted', () => {
    expect(() => cache.edit('my key')).toThrow(IllegalArgumentException);
  });

  test('keyWithNewlineNotPermitted', () => {
    expect(() => cache.edit('my\nkey')).toThrow(IllegalArgumentException);
  });

  test('keyWithCarriageReturnNotPermitted', () => {
    expect(() => cache.edit('my\rkey')).toThrow(IllegalArgumentException);
  });

  test('nullKeyThrows', () => {
    expect(() => cache.edit(null as unknown as string)).toThrow(NullPointerException);
  });

  test('createNewEntryWithTooFewValuesFails', () => {
    const creator = required(cache.edit('k1'));
    creator.set(1, 'A');
    expect(() => {
      creator.commit();
    }).toThrow(IllegalStateException);

    expect(FileUtils.exists(getCleanFile('k1', 0))).toBe(false);
    expect(FileUtils.exists(getCleanFile('k1', 1))).toBe(false);
    expect(FileUtils.exists(getDirtyFile('k1', 0))).toBe(false);
    expect(FileUtils.exists(getDirtyFile('k1', 1))).toBe(false);
    expect(cache.get('k1')).toBeNull();

    const creator2 = required(cache.edit('k1'));
    creator2.set(0, 'B');
    creator2.set(1, 'C');
    creator2.commit();
  });

  test('revertWithTooFewValues', () => {
    const creator = required(cache.edit('k1'));
    creator.set(1, 'A');
    creator.abort();
    expect(FileUtils.exists(getCleanFile('k1', 0))).toBe(false);
    expect(FileUtils.exists(getCleanFile('k1', 1))).toBe(false);
    expect(FileUtils.exists(getDirtyFile('k1', 0))).toBe(false);
    expect(FileUtils.exists(getDirtyFile('k1', 1))).toBe(false);
    expect(cache.get('k1')).toBeNull();
  });

  test('updateExistingEntryWithTooFewValuesReusesPreviousValues', () => {
    const creator = required(cache.edit('k1'));
    creator.set(0, 'A');
    creator.set(1, 'B');
    creator.commit();

    const updater = required(cache.edit('k1'));
    updater.set(0, 'C');
    updater.commit();

    const snapshot = required(cache.get('k1'));
    expect(snapshot.getString(0)).toEqual('C');
    expect(snapshot.getLength(0)).toEqual(1);
    expect(snapshot.getString(1)).toEqual('B');
    expect(snapshot.getLength(1)).toEqual(1);
    snapshot.close();
  });

  test('growMaxSize', () => {
    cache.close();
    cache = DiskLruCache.open(cacheDir, appVersion, 2, 10);
    set('a', 'a', 'aaa'); // size 4
    set('b', 'bb', 'bbbb'); // size 6
    cache.setMaxSize(20);
    set('c', 'c', 'c'); // size 12
    expect(cache.size()).toEqual(12);
  });

  test('shrinkMaxSizeEvicts', () => {
    cache.close();
    cache = DiskLruCache.open(cacheDir, appVersion, 2, 20);
    set('a', 'a', 'aaa'); // size 4
    set('b', 'bb', 'bbbb'); // size 6
    set('c', 'c', 'c'); // size 12
    cache.setMaxSize(10);
    expect(cache.executorService.getQueue().size()).toEqual(1);
    cache.executorService.purge();
  });

  test('evictOnInsert', () => {
    cache.close();
    cache = DiskLruCache.open(cacheDir, appVersion, 2, 10);

    set('a', 'a', 'aaa'); // size 4
    set('b', 'bb', 'bbbb'); // size 6
    expect(cache.size()).toEqual(10);

    // Cause the size to grow to 12 should evict 'A'.
    set('c', 'c', 'c');
    cache.flush();
    expect(cache.size()).toEqual(8);
    assertAbsent('a');
    assertValue('b', 'bb', 'bbbb');
    assertValue('c', 'c', 'c');

    // Causing the size to grow to 10 should evict nothing.
    set('d', 'd', 'd');
    cache.flush();
    expect(cache.size()).toEqual(10);
    assertAbsent('a');
    assertValue('b', 'bb', 'bbbb');
    assertValue('c', 'c', 'c');
    assertValue('d', 'd', 'd');

    // Causing the size to grow to 18 should evict 'B' and 'C'.
    set('e', 'eeee', 'eeee');
    cache.flush();
    expect(cache.size()).toEqual(10);
    assertAbsent('a');
    assertAbsent('b');
    assertAbsent('c');
    assertValue('d', 'd', 'd');
    assertValue('e', 'eeee', 'eeee');
  });

  test('evictOnUpdate', () => {
    cache.close();
    cache = DiskLruCache.open(cacheDir, appVersion, 2, 10);

    set('a', 'a', 'aa'); // size 3
    set('b', 'b', 'bb'); // size 3
    set('c', 'c', 'cc'); // size 3
    expect(cache.size()).toEqual(9);

    // Causing the size to grow to 11 should evict 'A'.
    set('b', 'b', 'bbbb');
    cache.flush();
    expect(cache.size()).toEqual(8);
    assertAbsent('a');
    assertValue('b', 'b', 'bbbb');
    assertValue('c', 'c', 'cc');
  });

  test('evictionHonorsLruFromCurrentSession', () => {
    cache.close();
    cache = DiskLruCache.open(cacheDir, appVersion, 2, 10);
    set('a', 'a', 'a');
    set('b', 'b', 'b');
    set('c', 'c', 'c');
    set('d', 'd', 'd');
    set('e', 'e', 'e');
    required(cache.get('b')).close(); // 'B' is now least recently used.

    // Causing the size to grow to 12 should evict 'A'.
    set('f', 'f', 'f');
    // Causing the size to grow to 12 should evict 'C'.
    set('g', 'g', 'g');
    cache.flush();
    expect(cache.size()).toEqual(10);
    assertAbsent('a');
    assertValue('b', 'b', 'b');
    assertAbsent('c');
    assertValue('d', 'd', 'd');
    assertValue('e', 'e', 'e');
    assertValue('f', 'f', 'f');
  });

  test('evictionHonorsLruFromPreviousSession', () => {
    set('a', 'a', 'a');
    set('b', 'b', 'b');
    set('c', 'c', 'c');
    set('d', 'd', 'd');
    set('e', 'e', 'e');
    set('f', 'f', 'f');
    required(cache.get('b')).close(); // 'B' is now least recently used.
    expect(cache.size()).toEqual(12);
    cache.close();
    cache = DiskLruCache.open(cacheDir, appVersion, 2, 10);

    set('g', 'g', 'g');
    cache.flush();
    expect(cache.size()).toEqual(10);
    assertAbsent('a');
    assertValue('b', 'b', 'b');
    assertAbsent('c');
    assertValue('d', 'd', 'd');
    assertValue('e', 'e', 'e');
    assertValue('f', 'f', 'f');
    assertValue('g', 'g', 'g');
  });

  test('cacheSingleEntryOfSizeGreaterThanMaxSize', () => {
    cache.close();
    cache = DiskLruCache.open(cacheDir, appVersion, 2, 10);
    set('a', 'aaaaa', 'aaaaaa'); // size=11
    cache.flush();
    assertAbsent('a');
  });

  test('cacheSingleValueOfSizeGreaterThanMaxSize', () => {
    cache.close();
    cache = DiskLruCache.open(cacheDir, appVersion, 2, 10);
    set('a', 'aaaaaaaaaaa', 'a'); // size=12
    cache.flush();
    assertAbsent('a');
  });

  test('constructorDoesNotAllowZeroCacheSize', () => {
    expect(() => DiskLruCache.open(cacheDir, appVersion, 2, 0)).toThrow(IllegalArgumentException);
  });

  test('constructorDoesNotAllowZeroValuesPerEntry', () => {
    expect(() => DiskLruCache.open(cacheDir, appVersion, 0, 10)).toThrow(IllegalArgumentException);
  });

  test('removeAbsentElement', () => {
    cache.remove('a');
  });

  test('readingTheSameStreamMultipleTimes', () => {
    set('a', 'a', 'b');
    const snapshot = required(cache.get('a'));
    expect(snapshot.getInputStream(0)).toBe(snapshot.getInputStream(0));
    snapshot.close();
  });

  test('rebuildJournalOnRepeatedReads', async () => {
    set('a', 'a', 'a');
    set('b', 'b', 'b');
    let lastJournalLength = 0;
    for (;;) {
      const journalLength = FileUtils.length(journalFile);
      assertValue('a', 'a', 'a');
      assertValue('b', 'b', 'b');
      if (journalLength < lastJournalLength) {
        process.stdout.write(
          `Journal compacted from ${lastJournalLength} bytes to ${journalLength} bytes\n`,
        );
        break; // Test passed!
      }
      lastJournalLength = journalLength;
      await runBackgroundWork();
    }
  });

  test('rebuildJournalOnRepeatedEdits', async () => {
    let lastJournalLength = 0;
    for (;;) {
      const journalLength = FileUtils.length(journalFile);
      set('a', 'a', 'a');
      set('b', 'b', 'b');
      if (journalLength < lastJournalLength) {
        process.stdout.write(
          `Journal compacted from ${lastJournalLength} bytes to ${journalLength} bytes\n`,
        );
        break;
      }
      lastJournalLength = journalLength;
      await runBackgroundWork();
    }

    // Sanity check that a rebuilt journal behaves normally.
    assertValue('a', 'a', 'a');
    assertValue('b', 'b', 'b');
  });

  /** @see https://github.com/JakeWharton/DiskLruCache/issues/28 */
  test('rebuildJournalOnRepeatedReadsWithOpenAndClose', async () => {
    set('a', 'a', 'a');
    set('b', 'b', 'b');
    let lastJournalLength = 0;
    for (;;) {
      const journalLength = FileUtils.length(journalFile);
      assertValue('a', 'a', 'a');
      assertValue('b', 'b', 'b');
      await runBackgroundWork();
      cache.close();
      cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
      if (journalLength < lastJournalLength) {
        process.stdout.write(
          `Journal compacted from ${lastJournalLength} bytes to ${journalLength} bytes\n`,
        );
        break; // Test passed!
      }
      lastJournalLength = journalLength;
    }
  });

  /** @see https://github.com/JakeWharton/DiskLruCache/issues/28 */
  test('rebuildJournalOnRepeatedEditsWithOpenAndClose', async () => {
    let lastJournalLength = 0;
    for (;;) {
      const journalLength = FileUtils.length(journalFile);
      set('a', 'a', 'a');
      set('b', 'b', 'b');
      await runBackgroundWork();
      cache.close();
      cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);
      if (journalLength < lastJournalLength) {
        process.stdout.write(
          `Journal compacted from ${lastJournalLength} bytes to ${journalLength} bytes\n`,
        );
        break;
      }
      lastJournalLength = journalLength;
    }
  });

  test('restoreBackupFile', () => {
    const creator = required(cache.edit('k1'));
    creator.set(0, 'ABC');
    creator.set(1, 'DE');
    creator.commit();
    cache.close();

    expect(FileUtils.renameTo(journalFile, journalBkpFile)).toBe(true);
    expect(FileUtils.exists(journalFile)).toBe(false);

    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);

    const snapshot = required(cache.get('k1'));
    expect(snapshot.getString(0)).toEqual('ABC');
    expect(snapshot.getLength(0)).toEqual(3);
    expect(snapshot.getString(1)).toEqual('DE');
    expect(snapshot.getLength(1)).toEqual(2);

    expect(FileUtils.exists(journalBkpFile)).toBe(false);
    expect(FileUtils.exists(journalFile)).toBe(true);
  });

  test('journalFileIsPreferredOverBackupFile', () => {
    let creator = required(cache.edit('k1'));
    creator.set(0, 'ABC');
    creator.set(1, 'DE');
    creator.commit();
    cache.flush();

    FileUtils.copyFile(journalFile, journalBkpFile);

    creator = required(cache.edit('k2'));
    creator.set(0, 'F');
    creator.set(1, 'GH');
    creator.commit();
    cache.close();

    expect(FileUtils.exists(journalFile)).toBe(true);
    expect(FileUtils.exists(journalBkpFile)).toBe(true);

    cache = DiskLruCache.open(cacheDir, appVersion, 2, INTEGER_MAX_VALUE);

    const snapshotA = required(cache.get('k1'));
    expect(snapshotA.getString(0)).toEqual('ABC');
    expect(snapshotA.getLength(0)).toEqual(3);
    expect(snapshotA.getString(1)).toEqual('DE');
    expect(snapshotA.getLength(1)).toEqual(2);

    const snapshotB = required(cache.get('k2'));
    expect(snapshotB.getString(0)).toEqual('F');
    expect(snapshotB.getLength(0)).toEqual(1);
    expect(snapshotB.getString(1)).toEqual('GH');
    expect(snapshotB.getLength(1)).toEqual(2);

    expect(FileUtils.exists(journalBkpFile)).toBe(false);
    expect(FileUtils.exists(journalFile)).toBe(true);
  });

  test('openCreatesDirectoryIfNecessary', () => {
    cache.close();
    const dir = tempDir.newFolder('testOpenCreatesDirectoryIfNecessary');
    cache = DiskLruCache.open(dir, appVersion, 2, INTEGER_MAX_VALUE);
    set('a', 'a', 'a');
    expect(FileUtils.exists(path.join(dir, 'a.0'))).toBe(true);
    expect(FileUtils.exists(path.join(dir, 'a.1'))).toBe(true);
    expect(FileUtils.exists(path.join(dir, 'journal'))).toBe(true);
  });

  test('fileDeletedExternally', () => {
    set('a', 'a', 'a');
    FileUtils.deleteFile(getCleanFile('a', 1));
    expect(cache.get('a')).toBeNull();
  });

  test('editSameVersion', () => {
    set('a', 'a', 'a');
    const snapshot = required(cache.get('a'));
    const editor = required(snapshot.edit());
    editor.set(1, 'a2');
    editor.commit();
    assertValue('a', 'a', 'a2');
  });

  test('editSnapshotAfterChangeAborted', () => {
    set('a', 'a', 'a');
    const snapshot = required(cache.get('a'));
    const toAbort = required(snapshot.edit());
    toAbort.set(0, 'b');
    toAbort.abort();
    const editor = required(snapshot.edit());
    editor.set(1, 'a2');
    editor.commit();
    assertValue('a', 'a', 'a2');
  });

  test('editSnapshotAfterChangeCommitted', () => {
    set('a', 'a', 'a');
    const snapshot = required(cache.get('a'));
    const toAbort = required(snapshot.edit());
    toAbort.set(0, 'b');
    toAbort.commit();
    expect(snapshot.edit()).toBeNull();
  });

  test('editSinceEvicted', () => {
    cache.close();
    cache = DiskLruCache.open(cacheDir, appVersion, 2, 10);
    set('a', 'aa', 'aaa'); // size 5
    const snapshot = required(cache.get('a'));
    set('b', 'bb', 'bbb'); // size 5
    set('c', 'cc', 'ccc'); // size 5; will evict 'A'
    cache.flush();
    expect(snapshot.edit()).toBeNull();
  });

  test('editSinceEvictedAndRecreated', () => {
    cache.close();
    cache = DiskLruCache.open(cacheDir, appVersion, 2, 10);
    set('a', 'aa', 'aaa'); // size 5
    const snapshot = required(cache.get('a'));
    set('b', 'bb', 'bbb'); // size 5
    set('c', 'cc', 'ccc'); // size 5; will evict 'A'
    set('a', 'a', 'aaaa'); // size 5; will evict 'B'
    cache.flush();
    expect(snapshot.edit()).toBeNull();
  });

  /** @see https://github.com/JakeWharton/DiskLruCache/issues/2 */
  test('aggressiveClearingHandlesWrite', () => {
    FileUtils.deleteDirectory(cacheDir);
    set('a', 'a', 'a');
    assertValue('a', 'a', 'a');
  });

  /** @see https://github.com/JakeWharton/DiskLruCache/issues/2 */
  test('aggressiveClearingHandlesEdit', () => {
    set('a', 'a', 'a');
    const a = required(required(cache.get('a')).edit());
    FileUtils.deleteDirectory(cacheDir);
    a.set(1, 'a2');
    a.commit();
  });

  test('removeHandlesMissingFile', () => {
    set('a', 'a', 'a');
    FileUtils.deleteFile(getCleanFile('a', 0));
    cache.remove('a');
  });

  /** @see https://github.com/JakeWharton/DiskLruCache/issues/2 */
  test('aggressiveClearingHandlesPartialEdit', () => {
    set('a', 'a', 'a');
    set('b', 'b', 'b');
    const a = required(required(cache.get('a')).edit());
    a.set(0, 'a1');
    FileUtils.deleteDirectory(cacheDir);
    a.set(1, 'a2');
    a.commit();
    expect(cache.get('a')).toBeNull();
  });

  /** @see https://github.com/JakeWharton/DiskLruCache/issues/2 */
  test('aggressiveClearingHandlesRead', () => {
    FileUtils.deleteDirectory(cacheDir);
    expect(cache.get('a')).toBeNull();
  });

  // ---------------------------------------------------------------- helpers

  function assertJournalEquals(...expectedBodyLines: string[]): void {
    const expectedLines = [MAGIC, VERSION_1, '100', '2', '', ...expectedBodyLines];
    expect(FileUtils.readLines(journalFile)).toEqual(expectedLines);
  }

  function createJournal(...bodyLines: string[]): void {
    createJournalWithHeader(MAGIC, VERSION_1, '100', '2', '', ...bodyLines);
  }

  function createJournalWithHeader(
    magic: string,
    version: string,
    appVersionValue: string,
    valueCount: string,
    blank: string,
    ...bodyLines: string[]
  ): void {
    let content = `${magic}\n${version}\n${appVersionValue}\n${valueCount}\n${blank}\n`;
    for (const line of bodyLines) {
      content += `${line}\n`;
    }
    FileUtils.writeStringToFile(journalFile, content);
  }

  function getCleanFile(key: string, index: number): string {
    return path.join(cacheDir, `${key}.${index}`);
  }

  function getDirtyFile(key: string, index: number): string {
    return path.join(cacheDir, `${key}.${index}.tmp`);
  }

  function writeFile(file: string, content: string): void {
    FileUtils.writeStringToFile(file, content);
  }

  function assertInoperable(editor: Editor): void {
    expect(() => editor.getString(0)).toThrow(IllegalStateException);
    expect(() => {
      editor.set(0, 'A');
    }).toThrow(IllegalStateException);
    expect(() => editor.newInputStream(0)).toThrow(IllegalStateException);
    expect(() => editor.newOutputStream(0)).toThrow(IllegalStateException);
    expect(() => {
      editor.commit();
    }).toThrow(IllegalStateException);
    expect(() => {
      editor.abort();
    }).toThrow(IllegalStateException);
  }

  function generateSomeGarbageFiles(): void {
    const dir1 = path.join(cacheDir, 'dir1');
    const dir2 = path.join(dir1, 'dir2');
    writeFile(getCleanFile('g1', 0), 'A');
    writeFile(getCleanFile('g1', 1), 'B');
    writeFile(getCleanFile('g2', 0), 'C');
    writeFile(getCleanFile('g2', 1), 'D');
    writeFile(getCleanFile('g2', 1), 'D');
    writeFile(path.join(cacheDir, 'otherFile0'), 'E');
    FileUtils.mkdir(dir1);
    FileUtils.mkdir(dir2);
    writeFile(path.join(dir2, 'otherFile1'), 'F');
  }

  function assertGarbageFilesAllDeleted(): void {
    expect(FileUtils.exists(getCleanFile('g1', 0))).toBe(false);
    expect(FileUtils.exists(getCleanFile('g1', 1))).toBe(false);
    expect(FileUtils.exists(getCleanFile('g2', 0))).toBe(false);
    expect(FileUtils.exists(getCleanFile('g2', 1))).toBe(false);
    expect(FileUtils.exists(path.join(cacheDir, 'otherFile0'))).toBe(false);
    expect(FileUtils.exists(path.join(cacheDir, 'dir1'))).toBe(false);
  }

  function set(key: string, value0: string, value1: string): void {
    const editor = required(cache.edit(key));
    editor.set(0, value0);
    editor.set(1, value1);
    editor.commit();
  }

  function assertAbsent(key: string): void {
    const snapshot = cache.get(key);
    if (snapshot !== null) {
      snapshot.close();
    }
    // Asserted rather than `fail()`-ed inside the branch so the check runs — and
    // is counted — on the passing path too.
    expect(snapshot, `expected ${key} to be absent`).toBeNull();
    expect(FileUtils.exists(getCleanFile(key, 0))).toBe(false);
    expect(FileUtils.exists(getCleanFile(key, 1))).toBe(false);
    expect(FileUtils.exists(getDirtyFile(key, 0))).toBe(false);
    expect(FileUtils.exists(getDirtyFile(key, 1))).toBe(false);
  }

  function assertValue(key: string, value0: string, value1: string): void {
    const snapshot: Snapshot = required(cache.get(key));
    expect(snapshot.getString(0)).toEqual(value0);
    expect(snapshot.getLength(0)).toEqual(value0.length);
    expect(snapshot.getString(1)).toEqual(value1);
    expect(snapshot.getLength(1)).toEqual(value1.length);
    expect(FileUtils.exists(getCleanFile(key, 0))).toBe(true);
    expect(FileUtils.exists(getCleanFile(key, 1))).toBe(true);
    snapshot.close();
  }

  /**
   * Mirrors the original's `try { … fail(…) } catch (IllegalArgumentException iae)`
   * pair: both that the call threw and that it threw the documented message.
   *
   * The thrown value is captured rather than asserted inside the `catch`, so a
   * call that does *not* throw reports "expected an IllegalArgumentException"
   * instead of having that very assertion caught by its own handler.
   */
  function expectIllegalArgument(action: () => unknown, key: string): void {
    let thrown: unknown;
    let threw = false;
    try {
      action();
    } catch (iae) {
      thrown = iae;
      threw = true;
    }
    expect(threw, 'Exepcting an IllegalArgumentException as the key was invalid.').toBe(true);
    expect(thrown).toBeInstanceOf(IllegalArgumentException);
    expect((thrown as IllegalArgumentException).message).toEqual(
      `keys must match regex [a-z0-9_-]{1,120}: "${key}"`,
    );
  }
});

/**
 * Asserts that an optional cache result is present, as the original's direct
 * use assumes.
 *
 * The original dereferences `cache.edit(…)` and `cache.get(…)` straight away
 * and lets the JVM raise a NullPointerException when they answer null. Here the
 * presence is asserted instead, so an unexpected null fails as a checked
 * expectation naming the value rather than as an opaque error later on.
 */
function required<T>(value: T | null | undefined, what = 'value'): T {
  expect(value, `expected a non-null ${what}`).not.toBeNull();
  expect(value, `expected a defined ${what}`).not.toBeUndefined();
  return value as T;
}

/**
 * Lets the cache's background worker run.
 *
 * The original's eviction and journal compaction happen on a separate thread,
 * so a tight `while` loop in a test still lets them make progress. Node runs
 * the worker on the event loop instead, which a synchronous loop would starve,
 * so the loop yields once per iteration.
 */
function runBackgroundWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
