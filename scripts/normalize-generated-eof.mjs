import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

async function normalizeDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalizeDirectory(path);
      continue;
    }
    if (!entry.isFile() || extname(entry.name) !== '.ts') continue;
    const source = await readFile(path, 'utf8');
    const normalized = `${source.trimEnd()}\n`;
    if (normalized !== source) await writeFile(path, normalized);
  }
}

const directory = process.argv[2];
if (!directory) throw new Error('generated source directory is required');
await normalizeDirectory(directory);
