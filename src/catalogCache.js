const { buildCatalogData } = require('./matching/eventBuilder');

const CATALOG_TTL_MS = 3 * 60 * 1000; // matches the ESPN schedule cache's freshness window
const cache = new Map(); // xtreamClient.key -> { data, fetchedAt, inflight }

async function getCatalogData(xtreamClient) {
  const key = xtreamClient.key;
  const entry = cache.get(key);
  const now = Date.now();
  if (entry && entry.data && now - entry.fetchedAt < CATALOG_TTL_MS) return entry.data;
  if (entry && entry.inflight) return entry.inflight;

  const inflight = buildCatalogData(xtreamClient)
    .then((data) => {
      cache.set(key, { data, fetchedAt: Date.now(), inflight: null });
      return data;
    })
    .catch((err) => {
      cache.set(key, { data: entry?.data || null, fetchedAt: entry?.fetchedAt || 0, inflight: null });
      throw err;
    });

  cache.set(key, { data: entry?.data || null, fetchedAt: entry?.fetchedAt || 0, inflight });
  try {
    return await inflight;
  } catch (err) {
    if (entry && entry.data) return entry.data;
    throw err;
  }
}

module.exports = { getCatalogData };
