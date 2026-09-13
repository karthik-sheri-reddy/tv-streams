// TheSportsDB (https://www.thesportsdb.com/docs_api_guide) - used purely to
// discover ADDITIONAL IPTV channel sources for an event we already know
// about: lookuptv.php lists real-world broadcasters for an event
// (e.g. "beIN Sports 1", "NBC", "Movistar Liga de Campeones"), which
// matching/eventBuilder.js then matches against the user's own channel list
// to attach channels our own name-parsing missed. This is never used for
// live/upcoming/ended status - that's ESPN's job alone (its "today"
// coverage is sparse for some sports/leagues, unlike ESPN's scoreboard).
const API_KEY = process.env.THESPORTSDB_API_KEY || '123'; // '123' is TheSportsDB's public test key
const BASE = `https://www.thesportsdb.com/api/v1/json/${API_KEY}`;

async function fetchJson(url, timeoutMs = 10000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// The shared public test key ('123') rate-limits hard (429s show up almost
// immediately under any real concurrency) - every request funnels through
// one queue with a minimum gap between them, regardless of how many callers
// are enriching events at once. A real key (set THESPORTSDB_API_KEY) can
// tolerate a shorter gap, but this stays conservative either way since nothing
// here is latency-critical - it's background enrichment.
const MIN_INTERVAL_MS = process.env.THESPORTSDB_API_KEY ? 300 : 1500;
let requestQueue = Promise.resolve();

function throttledFetchJson(url, timeoutMs) {
  const result = requestQueue.then(() => fetchJson(url, timeoutMs));
  const wait = () => new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS));
  requestQueue = result.then(wait, wait);
  return result;
}

// TheSportsDB's search matches against "Home vs Away"-formatted event names,
// so a source that lists the pairing in the other order needs a second try.
async function searchEventId(teamA, teamB) {
  for (const [a, b] of [
    [teamA, teamB],
    [teamB, teamA],
  ]) {
    const query = `${a}_vs_${b}`.replace(/\s+/g, '_');
    const url = `${BASE}/searchevents.php?e=${encodeURIComponent(query)}`;
    try {
      const data = await throttledFetchJson(url);
      const id = data?.event?.[0]?.idEvent;
      if (id) return id;
    } catch {
      // try the other ordering, or give up quietly below
    }
  }
  return null;
}

async function lookupBroadcastChannels(idEvent) {
  const data = await throttledFetchJson(`${BASE}/lookuptv.php?id=${idEvent}`);
  return (data.tvevent || []).map((t) => t.strChannel).filter(Boolean);
}

// Broadcaster assignments for an event barely change hour to hour, unlike
// live status - a much longer TTL than the catalog/ESPN caches is fine, and
// keeps this rarely-changing data from re-hitting a rate-limited free key.
const TTL_MS = 60 * 60 * 1000;
const eventIdCache = new Map(); // "teamA|teamB" -> { id, fetchedAt }
const broadcastCache = new Map(); // idEvent -> { channels, fetchedAt }

async function getBroadcastChannelNames(teamA, teamB) {
  const now = Date.now();
  const idKey = `${teamA}|${teamB}`;
  let idEntry = eventIdCache.get(idKey);
  if (!idEntry || now - idEntry.fetchedAt > TTL_MS) {
    const id = await searchEventId(teamA, teamB).catch(() => null);
    idEntry = { id, fetchedAt: now };
    eventIdCache.set(idKey, idEntry);
  }
  if (!idEntry.id) return [];

  let bEntry = broadcastCache.get(idEntry.id);
  if (!bEntry || now - bEntry.fetchedAt > TTL_MS) {
    const channels = await lookupBroadcastChannels(idEntry.id).catch(() => []);
    bEntry = { channels, fetchedAt: now };
    broadcastCache.set(idEntry.id, bEntry);
  }
  return bEntry.channels;
}

module.exports = { getBroadcastChannelNames };
