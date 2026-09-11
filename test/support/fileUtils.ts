import * as fs from 'node:fs';

/**
 * Replaces the two `org.apache.commons.io.FileUtils` methods the original
 * suite used.
 *
 * These are exercised in anger: `deleteDirectory` is how the aggressive-
 * clearing tests rip the cache directory out from under a live edit, so it has
 * to really remove a populated tree rather than fail on a non-empty directory.
 */

/** Recursively deletes a directory and everything under it. */
export function deleteDirectory(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

/** Copies a file, preserving its contents byte for byte. */
export function copyFile(source: string, destination: string): void {
  fs.copyFileSync(source, destination);
}

/** Reads a whole file as UTF-8 text. */
export function readFileToString(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Writes UTF-8 text to a file, replacing any existing contents. */
export function writeStringToFile(file: string, content: string): void {
  fs.writeFileSync(file, content, 'utf8');
}

/** Reads a file and splits it into lines, dropping a trailing newline. */
export function readLines(file: string): string[] {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** True if the path exists. */
export function exists(file: string): boolean {
  return fs.existsSync(file);
}

/** The size of the file in bytes, or 0 if it does not exist. */
export function length(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Renames a file, answering whether it worked. */
export function renameTo(from: string, to: string): boolean {
  try {
    fs.renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/** Deletes a file, answering whether it worked. */
export function deleteFile(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The paths of a directory's children, or an empty list if it is not one. */
export function listFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory).map((name) => `${directory}/${name}`);
  } catch {
    return [];
  }
}

/** Creates a single directory. */
export function mkdir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
}
