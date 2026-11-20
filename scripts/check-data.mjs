#!/usr/bin/env node
// Sanity check for data/: manifest parses, counts match, one random file per folder parses.
// Usage: node scripts/check-data.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const EXPECTED = 400;
const FOLDERS = ['occupations', 'personal-history', 'personal-info', 'personal-traits'];

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL', msg); };

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
for (const folder of FOLDERS) {
  const ids = manifest.folders?.[folder];
  if (!Array.isArray(ids)) { fail(`manifest missing ${folder}`); continue; }
  if (ids.length !== EXPECTED) fail(`${folder}: ${ids.length} ids, expected ${EXPECTED}`);
  const pick = ids[Math.floor(Math.random() * ids.length)];
  try {
    const obj = JSON.parse(await readFile(join(root, folder, `${pick}.json`), 'utf8'));
    if (obj.id !== pick) fail(`${folder}/${pick}.json has id ${obj.id}`);
    console.log(`OK ${folder}/${pick}.json`);
  } catch (err) {
    fail(`${folder}/${pick}.json: ${err.message}`);
  }
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('All data checks passed.');
