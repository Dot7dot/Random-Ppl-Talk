#!/usr/bin/env node
// Builds dist/RandomPplTalk-Windows.zip for distribution.
//
// Zip layout (top folder RandomPplTalk/):
//   Start-Game.bat
//   launcher/            (all files, from the repo's launcher/)
//   game/                (index.html, css/, js/, skill.md, data/)
//   README-遊戲說明.txt  (from packaging/, converted to UTF-8 BOM + CRLF)
//   models/.keep         (empty; the model is downloaded here on first run)
//   bin/.keep            (empty; llama.cpp is downloaded here on first run)
//
// Usage: npm run build:zip   (or: node scripts/build-zip.mjs)
// Needs: Node 18+. Uses the `zip` CLI if present, otherwise Python 3 (-I -c zipfile).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, '.stage');
const TOP = 'RandomPplTalk';
const OUT = path.join(DIST, `${TOP}-Windows.zip`);
const README_NAME = 'README-遊戲說明.txt';
const README_SRC = path.join(ROOT, 'packaging', README_NAME);

const GAME_ITEMS = ['index.html', 'css', 'js', 'skill.md', 'data'];

function fail(msg) {
  console.error(`[build-zip] ERROR: ${msg}`);
  process.exit(1);
}

function exists(p) {
  return fs.existsSync(p);
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(full, base));
    else if (ent.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// ---------- preflight: fail clearly if the Windows launcher is not in place yet ----------

const BATS = ['Start-Game.bat', 'Start-Game-Lite.bat', 'Start-Game-CPU.bat'];
const launcherDir = path.join(ROOT, 'launcher');

for (const bat of BATS) {
  if (!exists(path.join(ROOT, bat))) fail(`${bat} is missing at ${path.join(ROOT, bat)}. Build after the launcher step has written it.`);
}
if (!exists(launcherDir) || !fs.statSync(launcherDir).isDirectory()) fail(`launcher/ is missing at ${launcherDir}.`);
if (listFiles(launcherDir).length === 0) fail('launcher/ is empty.');
for (const item of GAME_ITEMS) {
  if (!exists(path.join(ROOT, item))) fail(`game file/folder missing: ${item}`);
}
if (!exists(README_SRC)) fail(`README source missing: ${path.relative(ROOT, README_SRC)}`);

// ---------- stage ----------

fs.rmSync(STAGE, { recursive: true, force: true });
const stageTop = path.join(STAGE, TOP);
fs.mkdirSync(stageTop, { recursive: true });

fs.copyFileSync(startBat, path.join(stageTop, 'Start-Game.bat'));
fs.cpSync(launcherDir, path.join(stageTop, 'launcher'), { recursive: true });

const gameOut = path.join(stageTop, 'game');
fs.mkdirSync(gameOut, { recursive: true });
for (const item of GAME_ITEMS) {
  const src = path.join(ROOT, item);
  const dst = path.join(gameOut, item);
  if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
  else fs.copyFileSync(src, dst);
}

// README: UTF-8 with BOM, CRLF line endings (Notepad-friendly on Windows).
const readmeText = fs.readFileSync(README_SRC, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
fs.writeFileSync(path.join(stageTop, README_NAME), '﻿' + readmeText, 'utf8');

for (const dir of ['models', 'bin']) {
  fs.mkdirSync(path.join(stageTop, dir), { recursive: true });
  fs.writeFileSync(path.join(stageTop, dir, '.keep'), '');
}
const stagedCount = listFiles(stageTop).length;

// ---------- zip ----------

fs.mkdirSync(DIST, { recursive: true });
fs.rmSync(OUT, { force: true });

function zipWithCli() {
  const probe = spawnSync('zip', ['-v'], { stdio: 'ignore' });
  if (probe.error || probe.status === null) return false;
  // -X: no extra attributes, -UN=UTF8: store Chinese file names as UTF-8.
  const r = spawnSync('zip', ['-r', '-X', '-q', '-UN=UTF8', OUT, TOP], { cwd: STAGE, stdio: 'inherit' });
  if (r.status !== 0) fail(`zip exited with status ${r.status}`);
  return true;
}

const PY_ZIP = `
import sys, os, zipfile
out, top, base = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for dp, dn, fn in os.walk(os.path.join(base, top)):
        dn.sort()
        for f in sorted(fn):
            full = os.path.join(dp, f)
            z.write(full, os.path.relpath(full, base).replace(os.sep, '/'))
`;

function zipWithPython() {
  for (const py of ['python3', 'python']) {
    const r = spawnSync(py, ['-I', '-c', PY_ZIP, OUT, TOP, STAGE], { stdio: 'inherit' });
    if (!r.error && r.status === 0) return true;
    if (r.status !== null && r.status !== 0) fail(`${py} zip step failed with status ${r.status}`);
  }
  return false;
}

let method;
try {
  if (zipWithCli()) method = 'zip CLI';
  else if (zipWithPython()) method = 'python zipfile';
  else fail('neither the zip CLI nor python3/python is available');
} finally {
  fs.rmSync(STAGE, { recursive: true, force: true });
}

// ---------- report ----------

const size = fs.statSync(OUT).size;

console.log(`[build-zip] method: ${method}`);
console.log(`[build-zip] wrote ${path.relative(ROOT, OUT)}`);
console.log(`[build-zip] size: ${(size / 1024 / 1024).toFixed(2)} MB (${size} bytes)`);
console.log(`[build-zip] files: ${stagedCount} (plus ${TOP}/ folder entries)`);
