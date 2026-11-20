#!/usr/bin/env node
// Copy and minify persona JSON from a House-Of-Tester checkout into data/.
// Usage: node scripts/sync-data.mjs [pathToHouseOfTester]   (default ../House-Of-Tester)

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const FOLDERS = ['occupations', 'personal-history', 'personal-info', 'personal-traits'];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const sourceRoot = resolve(process.argv[2] ?? join(repoRoot, '..', 'House-Of-Tester'));
const outRoot = join(repoRoot, 'data');

async function main() {
  const manifest = {
    source: basename(sourceRoot),
    generated_at: new Date().toISOString(),
    folders: {},
  };
  let copied = 0;
  let skipped = 0;

  // Rebuild data/ from scratch so removed source files do not linger.
  await rm(outRoot, { recursive: true, force: true });

  for (const folder of FOLDERS) {
    const srcDir = join(sourceRoot, folder);
    const outDir = join(outRoot, folder);
    await mkdir(outDir, { recursive: true });

    let names;
    try {
      names = (await readdir(srcDir)).filter((n) => n.endsWith('.json')).sort();
    } catch (err) {
      throw new Error(`Cannot read source folder ${srcDir}: ${err.message}`);
    }

    const ids = [];
    for (const name of names) {
      const id = basename(name, '.json');
      let data;
      try {
        data = JSON.parse(await readFile(join(srcDir, name), 'utf8'));
      } catch (err) {
        console.warn(`WARN skip ${folder}/${name}: invalid JSON (${err.message})`);
        skipped++;
        continue;
      }
      await writeFile(join(outDir, name), JSON.stringify(data));
      ids.push(id);
      copied++;
    }
    manifest.folders[folder] = ids;
    console.log(`${folder}: ${ids.length} files`);
  }

  await writeFile(join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Done. copied=${copied} skipped=${skipped} -> ${outRoot}`);
  if (copied === 0) throw new Error('No files copied; check the source path.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
