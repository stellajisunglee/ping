import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Everything lives in memory and is written to one JSON file after each change.
// That only works with a single server, which is all this app runs.
export class Store {
  constructor(file = null) {
    this.file = file;
    this.users = {};
    this.calls = {};
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      this.users = saved.users ?? {};
      this.calls = saved.calls ?? {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  // Writing to a temp file first means a crash mid-write can't corrupt the data.
  save() {
    if (!this.file) return;
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ users: this.users, calls: this.calls }));
    renameSync(temp, this.file);
  }
}
