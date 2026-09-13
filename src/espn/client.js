// Ground-truth schedule/live-status data from ESPN's public scoreboard API -
// the same undocumented-but-widely-used endpoint that Home Assistant's
// ha-teamtracker integration (https://github.com/vasqued2/ha-teamtracker)
// is built on: https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard
// No auth, no key. We use it to know which real-world games are actually
// live or starting soon, instead of trusting IPTV channel-name/EPG text for
// timing - that text is only used to *find* the matchup, ESPN tells us
// whether it's worth showing right now.
const { normalizeKey } = require('../matching/nameParser');

// Sports with a flat head-to-head competitions[0].competitors[] shape.
// (Golf/motorsport use leaderboard shapes ESPN structures very differently
// with no head-to-head competitor pair at all, and IPTV naming for those
// rarely yields a clean matchup anyway, so they're left out entirely.)
//
// NFL, NCAAF, NBA and NCAAB are listed first: they're the priority leagues,
// and findEspnMatch below returns the first match it finds, so listing them
// first also wins any (rare) cross-league team-name ambiguity.
const LEAGUES = [
  { sport: 'American Football', leaguePath: 'nfl', sportPath: 'football' },
  // NCAAF's default scoreboard only returns ~24 "featured" games; groups=80
  // (FBS) + a high limit gets the full Saturday slate, not just ranked teams.
  { sport: 'NCAAF', leaguePath: 'college-football', sportPath: 'football', query: 'groups=80&limit=300' },
  { sport: 'NBA', leaguePath: 'nba', sportPath: 'basketball' },
  { sport: 'NBA', leaguePath: 'wnba', sportPath: 'basketball' },
  { sport: 'NCAAB', leaguePath: 'mens-college-basketball', sportPath: 'basketball', query: 'limit=300' },
  { sport: 'NCAAB', leaguePath: 'womens-college-basketball', sportPath: 'basketball', query: 'limit=300' },
  { sport: 'Football', leaguePath: 'eng.1', sportPath: 'soccer' },
  { sport: 'Football', leaguePath: 'esp.1', sportPath: 'soccer' },
  { sport: 'Football', leaguePath: 'ger.1', sportPath: 'soccer' },
  { sport: 'Football', leaguePath: 'ita.1', sportPath: 'soccer' },
  { sport: 'Football', leaguePath: 'fra.1', sportPath: 'soccer' },
  { sport: 'Football', leaguePath: 'uefa.champions', sportPath: 'soccer' },
  { sport: 'Football', leaguePath: 'uefa.europa', sportPath: 'soccer' },
  { sport: 'Football', leaguePath: 'usa.1', sportPath: 'soccer' },
  { sport: 'Hockey', leaguePath: 'nhl', sportPath: 'hockey' },
  { sport: 'Baseball', leaguePath: 'mlb', sportPath: 'baseball' },
  { sport: 'Fight', leaguePath: 'ufc', sportPath: 'mma' },
  { sport: 'AFL', leaguePath: 'afl', sportPath: 'australian-football' },
  // Tennis "events" are whole tournaments, not single matches - individual
  // matches are nested under groupings[] (Men's/Women's Singles, Doubles),
  // handled below by flattenCompetitions. ATP and WTA overlap on shared
  // tournaments (e.g. Grand Slams list both draws under either endpoint)
  // but each also carries tour-exclusive events the other doesn't, so both
  // are queried; a match found on both sides just matches twice, harmlessly.
  { sport: 'Tennis', leaguePath: 'atp', sportPath: 'tennis' },
  { sport: 'Tennis', leaguePath: 'wta', sportPath: 'tennis' },
];

const STATE_MAP = { pre: 'upcoming', in: 'live', post: 'ended' };

// Most sports put one match directly in event.competitions[0]. Tennis nests
// many matches per tournament-event under groupings[].competitions[].
function flattenCompetitions(ev) {
  if (Array.isArray(ev.competitions)) return ev.competitions;
  if (Array.isArray(ev.groupings)) return ev.groupings.flatMap((g) => g.competitions || []);
  return [];
}

function parseCompetition(comp, league) {
  const state = comp?.status?.type?.state;
  const start = Date.parse(comp?.date);
  if (!comp || !STATE_MAP[state] || !Number.isFinite(start)) return null;

  const competitors = comp.competitors || [];
  if (competitors.length < 2) return null;
  // homeAway is present for team sports, absent for 1v1 (UFC/tennis singles); fall back to array order.
  const home = competitors.find((c) => c.homeAway === 'home') || competitors[0];
  const away = competitors.find((c) => c.homeAway === 'away') || competitors[1];
  const nameOf = (c) => c.athlete?.displayName || c.team?.displayName;
  const shortNameOf = (c) => c.athlete?.shortName || c.team?.shortDisplayName || nameOf(c);
  const logoOf = (c) => c.athlete?.headshot?.href || c.team?.logo;
  if (!nameOf(home) || !nameOf(away)) return null;

  return {
    sport: league.sport,
    league: league.leaguePath,
    teamA: nameOf(home),
    teamB: nameOf(away),
    keyA: normalizeKey(shortNameOf(home)),
    keyB: normalizeKey(shortNameOf(away)),
    altKeyA: normalizeKey(nameOf(home)),
    altKeyB: normalizeKey(nameOf(away)),
    logoA: logoOf(home) || null,
    logoB: logoOf(away) || null,
    start,
    status: STATE_MAP[state],
    // Some US broadcasters (a national ABC/FOX college-football window) run
    // the identical feed on every local affiliate with only a generic EPG
    // title ("College Football") - the venue in its description is often
    // the only text that identifies which specific game that actually is.
    venue: comp.venue?.fullName || null,
    venueCity: comp.venue?.address?.city || null,
    // ESPN already names the actual broadcaster(s) for most US sports
    // (NFL/NCAAF/MLB almost always, soccer often - "NBC", "FOX", "Peacock",
    // "BTN", "MLB.TV", regional team feeds like "YES"/"Marquee Sports Net")
    // right in the scoreboard response we're already fetching for status -
    // no extra request needed, unlike TheSportsDB's broadcaster lookup.
    broadcastNames: (comp.broadcasts || []).flatMap((b) => b.names || []),
  };
}

async function fetchLeague(league) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${league.sportPath}/${league.leaguePath}/scoreboard${league.query ? `?${league.query}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const events = [];

  for (const ev of data.events || []) {
    for (const comp of flattenCompetitions(ev)) {
      const parsed = parseCompetition(comp, league);
      if (parsed) events.push(parsed);
    }
  }

  return events;
}

const TTL_MS = 3 * 60 * 1000; // live status changes fast; keep this fresh
let cache = { data: null, fetchedAt: 0, inflight: null };

async function getSchedule() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < TTL_MS) return cache.data;
  if (cache.inflight) return cache.inflight;

  cache.inflight = Promise.allSettled(LEAGUES.map(fetchLeague)).then((results) => {
    const events = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
    cache = { data: events, fetchedAt: Date.now(), inflight: null };
    return events;
  });

  try {
    return await cache.inflight;
  } catch (err) {
    cache.inflight = null;
    if (cache.data) return cache.data;
    return [];
  }
}

// Team rosters for the /configure "Favorite Teams" pickers - only the
// leagues favoriting is offered for (see matching/sportTaxonomy.js's
// FAVORITE_TEAM_SPORTS). Men's pro/college only for football/basketball,
// matching how those two names are used colloquially - not meant to exclude
// WNBA/women's CBB, just keeping the picker's scope to what was actually
// asked for. Hockey/Baseball only have one top pro league each, so there's
// no men's/women's or pro/college split to make there.
const TEAM_LIST_LEAGUES = {
  'American Football': { sportPath: 'football', leaguePath: 'nfl' },
  NCAAF: { sportPath: 'football', leaguePath: 'college-football', query: 'limit=500' },
  NBA: { sportPath: 'basketball', leaguePath: 'nba' },
  NCAAB: { sportPath: 'basketball', leaguePath: 'mens-college-basketball', query: 'limit=500' },
  Hockey: { sportPath: 'hockey', leaguePath: 'nhl' },
  Baseball: { sportPath: 'baseball', leaguePath: 'mlb' },
};

const TEAM_LIST_TTL_MS = 24 * 60 * 60 * 1000; // team names/logos are effectively static
const teamListCache = new Map(); // sport -> { data, fetchedAt }

async function getTeams(sport) {
  const league = TEAM_LIST_LEAGUES[sport];
  if (!league) return [];
  const cached = teamListCache.get(sport);
  if (cached && Date.now() - cached.fetchedAt < TEAM_LIST_TTL_MS) return cached.data;

  const url = `https://site.api.espn.com/apis/site/v2/sports/${league.sportPath}/${league.leaguePath}/teams${league.query ? `?${league.query}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const teams = (data.sports?.[0]?.leagues?.[0]?.teams || [])
    .map((t) => ({ id: t.team.id, name: t.team.displayName, logo: t.team.logos?.[0]?.href || null }))
    .sort((a, b) => a.name.localeCompare(b.name));

  teamListCache.set(sport, { data: teams, fetchedAt: Date.now() });
  return teams;
}

module.exports = { getSchedule, getTeams, TEAM_LIST_LEAGUES };
