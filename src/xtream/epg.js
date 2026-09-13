// Fetches the panel's xmltv.php EPG dump (can be tens of MB) and parses it
// with plain regexes rather than a full XML DOM - the file is single-line
// XMLTV with a very regular shape, and a DOM parse of 150k+ <programme>
// nodes is unnecessary work for data we only read once into flat maps.
//
// This is used purely as a *matchup-discovery* aid on the backend: a linear
// channel's own name is often just a brand ("beIN Sports 1") with no team
// names in it, but its current EPG programme title often has them
// ("Liverpool vs Fulham"). None of this feeds the displayed live/upcoming
// status - that's ESPN's job alone (see matching/eventBuilder.js).
const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITY_MAP[name]);
}

// "20260911190000 +0100" -> epoch millis
function parseXmltvTime(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  const offset = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : 'Z';
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${tz ? offset : 'Z'}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const CHANNEL_RE = /<channel id="([^"]*)"\s*>(?:\s*<display-name[^>]*>([^<]*)<\/display-name>)?(?:\s*<icon src="([^"]*)"\s*\/>)?/g;
const PROGRAMME_RE = /<programme start="([^"]*)" stop="([^"]*)" channel="([^"]*)"\s*>([\s\S]*?)<\/programme>/g;
const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/;
const DESC_RE = /<desc[^>]*>([^<]*)<\/desc>/;

function parseXmltv(xml) {
  const channels = new Map(); // id -> { name, icon }
  const programmesByChannel = new Map(); // id -> [{start, stop, title, desc}]

  for (const m of xml.matchAll(CHANNEL_RE)) {
    const [, id, name, icon] = m;
    if (!id || channels.has(id)) continue;
    channels.set(id, { name: decodeEntities(name || '').trim(), icon: icon || null });
  }

  for (const m of xml.matchAll(PROGRAMME_RE)) {
    const [, startRaw, stopRaw, channelId, body] = m;
    const start = parseXmltvTime(startRaw);
    const stop = parseXmltvTime(stopRaw);
    if (!start || !stop || !channelId) continue;
    const titleMatch = TITLE_RE.exec(body);
    const descMatch = DESC_RE.exec(body);
    const title = decodeEntities(titleMatch ? titleMatch[1] : '').trim();
    if (!title) continue;
    const desc = decodeEntities(descMatch ? descMatch[1] : '').trim();
    let list = programmesByChannel.get(channelId);
    if (!list) {
      list = [];
      programmesByChannel.set(channelId, list);
    }
    list.push({ start, stop, title, desc });
  }

  for (const list of programmesByChannel.values()) list.sort((a, b) => a.start - b.start);

  return { channels, programmesByChannel };
}

// Current-or-next programme *title text* for a channel at time `now` - used
// only to find matchup text, not to decide live/upcoming state.
function currentProgramme(epg, channelId, now) {
  const list = epg.programmesByChannel.get(channelId);
  if (!list || list.length === 0) return null;
  for (const p of list) {
    if (now >= p.start && now < p.stop) return p;
  }
  return list.find((p) => p.start > now) || null;
}

const EPG_TTL_MS = 3 * 60 * 60 * 1000; // panels regenerate xmltv infrequently
const cache = new Map(); // clientKey -> { data, fetchedAt, inflight }

async function getEpg(xtreamClient) {
  const key = xtreamClient.key;
  const entry = cache.get(key);
  const now = Date.now();
  if (entry && entry.data && now - entry.fetchedAt < EPG_TTL_MS) return entry.data;
  if (entry && entry.inflight) return entry.inflight;

  const inflight = (async () => {
    const res = await fetch(xtreamClient.xmltvUrl(), { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`EPG fetch failed: HTTP ${res.status}`);
    const xml = await res.text();
    const parsed = parseXmltv(xml);
    cache.set(key, { data: parsed, fetchedAt: Date.now(), inflight: null });
    return parsed;
  })();

  cache.set(key, { data: entry?.data || null, fetchedAt: entry?.fetchedAt || 0, inflight });
  try {
    return await inflight;
  } catch (err) {
    // keep serving stale data (if any) on a refresh failure
    if (entry && entry.data) return entry.data;
    cache.delete(key);
    throw err;
  }
}

module.exports = { getEpg, parseXmltv, currentProgramme, decodeEntities };
