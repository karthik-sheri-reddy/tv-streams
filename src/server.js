const path = require('path');
const express = require('express');
const {
  encodeConfig,
  decodeConfig,
  TIMEZONES,
  MIN_UPCOMING_WINDOW_HOURS,
  MAX_UPCOMING_WINDOW_HOURS,
  DEFAULT_UPCOMING_WINDOW_HOURS,
} = require('./config');
const { XtreamClient } = require('./xtream/client');
const { getCatalogData } = require('./catalogCache');
const { buildManifest } = require('./stremio/manifest');
const {
  eventToMetaPreview,
  eventToMetaDetail,
  channelToMetaPreview,
  channelToMetaDetail,
  sortEvents,
} = require('./stremio/metas');
const { SPORTS, sportFromSlug } = require('./matching/sportTaxonomy');
const { isVisibleNow, sortSourcesByQuality } = require('./matching/eventBuilder');
const { getTeams } = require('./espn/client');
const { similarity } = require('./matching/fuzzy');
const { normalizeKey } = require('./matching/nameParser');
const { buildPosterSvg } = require('./stremio/poster');

const PORT = process.env.PORT || 7788;
const PAGE_SIZE = 100;
// Prefixed onto each stream's title in the Stremio source picker so the
// quality-sorted order is visible, not just implied by position in the list.
const QUALITY_TAGS = { 4: '[4K] ', 3: '[FHD] ', 2: '[HD] ', 1: '[SD] ' };

const app = express();
app.use(express.json());

// Stremio clients fetch addon endpoints cross-origin - required on every response.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => res.redirect('/configure'));

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'configure.html'));
});

app.get('/api/sports', (req, res) => res.json(SPORTS));
app.get('/api/timezones', (req, res) => res.json(TIMEZONES));
app.get('/api/upcoming-window-limits', (req, res) =>
  res.json({ min: MIN_UPCOMING_WINDOW_HOURS, max: MAX_UPCOMING_WINDOW_HOURS, default: DEFAULT_UPCOMING_WINDOW_HOURS })
);

// Team list for the /configure "Favorite Teams" picker - only defined for
// the four leagues favoriting is offered for (see espn/client.js).
app.get('/api/teams/:sport', async (req, res) => {
  try {
    const teams = await getTeams(req.params.sport);
    res.json(teams);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Stateless matchup poster: SVG with the two ESPN team logos side by side,
// or a text-only "Team A vs Team B" card when a logo isn't available. Takes
// its inputs as query params rather than an event id so it needs no Xtream
// lookup/config at all - just render whatever the meta builder asked for.
// Browsers refuse to load *external* resources referenced from inside an SVG
// when that SVG is itself loaded as an <img> (the "image context" sandbox -
// true in Chromium and Firefox alike, and Stremio's poster/background tags
// are exactly that: an <img src="...svg">). A team-logo <image href="https://
// ..."> inside our poster would just render blank. Fetching each logo once
// and inlining it as a data: URI sidesteps that restriction entirely - no
// further network fetch happens when the browser paints the image tag, so
// the "no external resources" rule never comes into play. Logos are cached
// indefinitely (team badges are effectively static).
const logoDataUriCache = new Map(); // url -> data URI, or null if it failed
async function fetchLogoDataUri(url) {
  if (!url) return null;
  if (logoDataUriCache.has(url)) return logoDataUriCache.get(url);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await res.arrayBuffer());
    const dataUri = `data:${contentType};base64,${buf.toString('base64')}`;
    logoDataUriCache.set(url, dataUri);
    return dataUri;
  } catch (err) {
    console.error('logo fetch failed:', url, err.message);
    logoDataUriCache.set(url, null);
    return null;
  }
}

app.get('/poster/event.svg', async (req, res) => {
  const { a, b, sport, logoA, logoB } = req.query;
  if (!a || !b) return res.status(400).send('Missing team names');
  const [dataUriA, dataUriB] = await Promise.all([fetchLogoDataUri(logoA), fetchLogoDataUri(logoB)]);
  const svg = buildPosterSvg({ teamA: a, teamB: b, sport: sport || 'Other', logoA: dataUriA, logoB: dataUriB });
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=600');
  res.send(svg);
});

// Validates Xtream creds live from the configure page before install.
app.post('/api/test-connection', async (req, res) => {
  try {
    const client = new XtreamClient(req.body);
    const info = await client.getAccountInfo();
    if (!info?.user_info) throw new Error('Unexpected response from server');
    res.json({
      ok: true,
      status: info.user_info.status,
      expDate: info.user_info.exp_date,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/encode-config', (req, res) => {
  try {
    const encoded = encodeConfig(req.body);
    res.json({ config: encoded });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function loadConfig(req, res) {
  try {
    return decodeConfig(req.params.config);
  } catch (err) {
    res.status(400).json({ error: `Invalid addon config: ${err.message}` });
    return null;
  }
}

function parseExtra(extraStr) {
  const extra = {};
  if (!extraStr) return extra;
  for (const pair of extraStr.split('&')) {
    const [k, v] = pair.split('=');
    if (k) extra[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return extra;
}

app.get('/:config/manifest.json', (req, res) => {
  const config = loadConfig(req, res);
  if (!config) return;
  res.json(buildManifest(config));
});

// A moderately lenient fuzzy check (not the stricter samePairing used for
// matchup grouping) since favorite-team names come verbatim from ESPN's own
// team list while ev.teamA/teamB are whatever our own matching extracted -
// often identical, but not guaranteed to be ("Bills" vs "Buffalo Bills").
const FAVORITE_MATCH_THRESHOLD = 0.6;
function eventMatchesFavorites(ev, favorites) {
  return favorites.some((f) => {
    const fk = normalizeKey(f);
    return similarity(normalizeKey(ev.teamA), fk) >= FAVORITE_MATCH_THRESHOLD || similarity(normalizeKey(ev.teamB), fk) >= FAVORITE_MATCH_THRESHOLD;
  });
}

async function handleCatalog(req, res) {
  const config = loadConfig(req, res);
  if (!config) return;
  const { type, id } = req.params;
  const extra = parseExtra(req.params.extra);
  if (type !== 'tv') return res.json({ metas: [] });

  const sport = id.startsWith('xiptv-sport-') ? sportFromSlug(id.slice('xiptv-sport-'.length)) : null;
  if (!sport) return res.json({ metas: [] });

  try {
    const client = new XtreamClient(config);
    const data = await getCatalogData(client);
    const skip = parseInt(extra.skip, 10) || 0;
    const search = (extra.search || '').trim().toLowerCase();
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const upcomingWindowMs = config.upcomingWindowHours * 60 * 60 * 1000;
    const favoritesOnly = extra.genre === 'Favorites';

    let events = data.events.filter((e) => e.sport === sport);
    events = events.filter((e) => isVisibleNow(e, Date.now(), upcomingWindowMs)); // baseline: live, or starting within the configured window
    if (config.liveOnly) events = events.filter((e) => e.status === 'live'); // further narrow to live-only
    if (favoritesOnly) {
      const favorites = config.favoriteTeams[sport] || [];
      events = favorites.length ? events.filter((e) => eventMatchesFavorites(e, favorites)) : [];
    }
    if (search) {
      events = events.filter(
        (e) => e.teamA.toLowerCase().includes(search) || e.teamB.toLowerCase().includes(search)
      );
    }
    events = sortEvents(events);

    // Favorites is about specific teams' games - a plain linear channel has
    // no team to favorite, so it's out of scope for that view rather than
    // shown unconditionally.
    let channels = favoritesOnly ? [] : data.channels.filter((c) => c.sport === sport);
    if (search) channels = channels.filter((c) => c.name.toLowerCase().includes(search));

    const metas = [
      ...events.map((e) => eventToMetaPreview(e, config, baseUrl)),
      ...channels.map((c) => channelToMetaPreview(c, config)),
    ].slice(skip, skip + PAGE_SIZE);

    res.json({ metas });
  } catch (err) {
    console.error('catalog error:', err.message);
    res.status(502).json({ metas: [], error: err.message });
  }
}

app.get('/:config/catalog/:type/:id.json', handleCatalog);
app.get('/:config/catalog/:type/:id/:extra.json', handleCatalog);

app.get('/:config/meta/:type/:id.json', async (req, res) => {
  const config = loadConfig(req, res);
  if (!config) return;
  const { id } = req.params;

  try {
    const client = new XtreamClient(config);
    const data = await getCatalogData(client);

    if (id.startsWith('xiptv-event-')) {
      const hash = id.slice('xiptv-event-'.length);
      const ev = data.events.find((e) => e.id === hash);
      if (!ev) return res.status(404).json({ error: 'Not found' });
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      return res.json({ meta: eventToMetaDetail(ev, config, baseUrl) });
    }
    if (id.startsWith('xiptv-channel-')) {
      const hash = id.slice('xiptv-channel-'.length);
      const ch = data.channels.find((c) => c.id === hash);
      if (!ch) return res.status(404).json({ error: 'Not found' });
      return res.json({ meta: channelToMetaDetail(ch, config) });
    }
    res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('meta error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/:config/stream/:type/:id.json', async (req, res) => {
  const config = loadConfig(req, res);
  if (!config) return;
  const { id } = req.params;

  try {
    const client = new XtreamClient(config);
    const data = await getCatalogData(client);

    if (id.startsWith('xiptv-event-')) {
      const hash = id.slice('xiptv-event-'.length);
      const ev = data.events.find((e) => e.id === hash);
      if (!ev) return res.json({ streams: [] });
      const streams = sortSourcesByQuality(ev.sources).map((src) => ({
        title: `${QUALITY_TAGS[src.quality] || ''}${src.label || `Source ${src.streamId}`}`,
        url: client.buildStreamUrl(src.streamId, 'm3u8'),
      }));
      return res.json({ streams });
    }
    if (id.startsWith('xiptv-channel-')) {
      const hash = id.slice('xiptv-channel-'.length);
      const ch = data.channels.find((c) => c.id === hash);
      if (!ch) return res.json({ streams: [] });
      return res.json({
        streams: [{ title: ch.name, url: client.buildStreamUrl(ch.streamId, 'm3u8') }],
      });
    }
    res.json({ streams: [] });
  } catch (err) {
    console.error('stream error:', err.message);
    res.status(502).json({ streams: [], error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Xtream Sports Stremio addon running at http://127.0.0.1:${PORT}`);
  console.log(`Configure it at http://127.0.0.1:${PORT}/configure`);
});

module.exports = app;
