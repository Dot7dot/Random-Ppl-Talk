// Browser ES module: loads the persona database produced by scripts/sync-data.mjs.
//
// Exports:
//   loadManifest(base = './data')                      -> manifest object (cached)
//   loadRandomPersona(base = './data', rng = Math.random, options = {})
//     -> { info, history, traits, occupation, ids: { info, history, traits, occupation } }
//   options.excludeOccupationIds: Set | Array of occupation ids to avoid.

const manifestCache = new Map(); // base -> Promise<manifest>

function normalizeBase(base) {
  return String(base).replace(/\/+$/, '');
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'force-cache' });
  } catch (err) {
    throw new Error(`Network error while loading ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Failed to load ${url} (HTTP ${res.status})`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`Invalid JSON in ${url}: ${err.message}`);
  }
}

export function loadManifest(base = './data') {
  const key = normalizeBase(base);
  if (!manifestCache.has(key)) {
    const p = fetchJson(`${key}/manifest.json`);
    // Do not keep failed loads cached; allow a retry on the next call.
    p.catch(() => manifestCache.delete(key));
    manifestCache.set(key, p);
  }
  return manifestCache.get(key);
}

function pickOne(ids, rng) {
  const r = rng();
  const i = Math.min(ids.length - 1, Math.max(0, Math.floor(r * ids.length)));
  return ids[i];
}

export async function loadRandomPersona(base = './data', rng = Math.random, options = {}) {
  const root = normalizeBase(base);
  const manifest = await loadManifest(root);
  const folders = manifest.folders ?? {};

  for (const name of ['personal-info', 'personal-history', 'personal-traits', 'occupations']) {
    if (!Array.isArray(folders[name]) || folders[name].length === 0) {
      throw new Error(`Manifest has no ids for folder "${name}"`);
    }
  }

  // Each folder is picked independently; ids need not match across folders.
  const excluded = new Set(options.excludeOccupationIds ?? []);
  let occupationPool = folders.occupations.filter((id) => !excluded.has(id));
  if (occupationPool.length === 0) occupationPool = folders.occupations;

  const ids = {
    info: pickOne(folders['personal-info'], rng),
    history: pickOne(folders['personal-history'], rng),
    traits: pickOne(folders['personal-traits'], rng),
    occupation: pickOne(occupationPool, rng),
  };

  const [info, history, traits, occupation] = await Promise.all([
    fetchJson(`${root}/personal-info/${ids.info}.json`),
    fetchJson(`${root}/personal-history/${ids.history}.json`),
    fetchJson(`${root}/personal-traits/${ids.traits}.json`),
    fetchJson(`${root}/occupations/${ids.occupation}.json`),
  ]);

  return { info, history, traits, occupation, ids };
}
