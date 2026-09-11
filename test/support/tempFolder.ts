import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Replaces JUnit's `TemporaryFolder` rule.
 *
 * Each test gets a private directory that is removed afterwards, so the suite
 * can run in any order and a test that deliberately corrupts a cache directory
 * cannot affect its neighbours.
 */
export class TemporaryFolder {
  private root: string | null = null;

  create(): void {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'DiskLruCache-'));
  }

  /** Creates and returns a new folder inside the temporary root. */
  newFolder(name: string): string {
    if (this.root === null) {
      throw new Error('TemporaryFolder was not created');
    }
    const folder = path.join(this.root, name);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
  }

  delete(): void {
    if (this.root !== null) {
      fs.rmSync(this.root, { recursive: true, force: true });
      this.root = null;
    }
  }
}
