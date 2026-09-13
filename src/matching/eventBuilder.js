const crypto = require('crypto');
const { classifyCategory, classifyText, PRIORITY_SPORTS, FAVORITE_TEAM_SPORTS } = require('./sportTaxonomy');
const { stripNoise, extractMatchup, normalizeKey, detectQualityRank } = require('./nameParser');
const { samePairing, pairingOrientation, brandMatch, similarity } = require('./fuzzy');
const { getSchedule, getTeams } = require('../espn/client');
const { getEpg, currentProgramme } = require('../xtream/epg');
const { getBroadcastChannelNames } = require('../sportsdb/client');

const UPCOMING_WINDOW_MS = 3 * 60 * 60 * 1000;
// Guards against fuzzy-matching two different fixtures between the same
// pair of teams played on different days (rare, but rivalries repeat).
const ESPN_MATCH_TOLERANCE_MS = 20 * 60 * 60 * 1000;
const BROADCAST_MATCH_THRESHOLD = 0.85;

function hashId(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

// Builds the full candidate list: every live-category stream, classified by
// sport and (where possible) resolved to a two-team matchup - first by
// parsing the stream's own name, falling back to its current EPG programme
// title when the name alone is just a brand/placeholder (a linear channel
// like "beIN Sports 1" names no teams, but its current programme often
// does). The EPG is used purely to *find* matchup text here - it never sets
// timing or live/upcoming state, which is entirely ESPN's job once matchups
// are grouped (see applyEspnSchedule below). A stream that doesn't parse to
// a matchup falls back to a plain channel entry.
async function buildRawItems(xtreamClient) {
  const [categories, streams, epg] = await Promise.all([
    xtreamClient.getLiveCategories(),
    xtreamClient.getAllLiveStreams(),
    getEpg(xtreamClient).catch(() => ({ channels: new Map(), programmesByChannel: new Map() })),
  ]);

  const categorySport = new Map();
  for (const c of categories) {
    const sport = classifyCategory(c.category_name);
    if (sport) categorySport.set(String(c.category_id), sport);
  }

  const now = Date.now();
  const items = [];

  for (const s of streams) {
    const catSport = categorySport.get(String(s.category_id));
    if (!catSport) continue;

    const cleanedName = stripNoise(s.name || '');
    let matchup = extractMatchup(cleanedName);
    let sportHintText = cleanedName;

    if (!matchup && s.epg_channel_id) {
      const prog = currentProgramme(epg, s.epg_channel_id, now);
      if (prog) {
        matchup = extractMatchup(stripNoise(prog.title));
        if (matchup) sportHintText = `${prog.title} ${cleanedName}`;
      }
    }

    const sport = (matchup && classifyText(`${matchup.sportHint} ${sportHintText}`)) || catSport;

    if (matchup) {
      items.push({
        type: 'event',
        sport,
        teamA: matchup.teamA,
        teamB: matchup.teamB,
        keyA: normalizeKey(matchup.teamA),
        keyB: normalizeKey(matchup.teamB),
        streamId: s.stream_id,
        icon: s.stream_icon || null,
        sourceName: cleanedName || s.name,
        quality: detectQualityRank(s.name),
      });
    } else {
      // No matchup anywhere (name or EPG) - this channel is either a real
      // standalone network (ESPN, beIN Sports 1) or a generic "slot" that
      // shows a *different* game each time depending on schedule (a team-
      // specific local affiliate, a numbered "NFL Game Pass 5"/"NCAAF 37").
      // epgText carries whatever the EPG *did* say (a generic sport label,
      // a venue in the description) for the slot-matching pass in
      // buildCatalogData to work with - it's the only place that context is
      // available, since nothing else keeps raw EPG text around.
      let epgText = '';
      if (s.epg_channel_id) {
        const prog = currentProgramme(epg, s.epg_channel_id, now);
        if (prog) epgText = `${prog.title} ${prog.desc || ''}`.trim();
      }
      items.push({
        type: 'channel',
        sport,
        name: cleanedName || s.name,
        streamId: s.stream_id,
        icon: s.stream_icon || null,
        quality: detectQualityRank(s.name),
        epgText,
      });
    }
  }

  return items;
}

// Groups event items that are really the same real-world matchup shown
// through multiple sources (different providers/backups rebroadcasting the
// same game) into a single catalog entry with several playable sources.
// Nothing here has a start time yet (that only exists post-ESPN-match), so
// grouping is purely a fuzzy team-pairing match.
function groupEvents(eventItems) {
  const groups = [];

  for (const item of eventItems) {
    // Sport classification is a hint, not ground truth (many sources give no
    // strong signal and fall back to 'Other') - two entries with the same
    // pairing shouldn't split into separate catalog cards just because one
    // source's text happened to name the league and another didn't.
    let group = null;
    let orientation = null;
    for (const g of groups) {
      if (g.sport !== item.sport && g.sport !== 'Other' && item.sport !== 'Other') continue;
      const o = pairingOrientation(g.keyA, g.keyB, item.keyA, item.keyB);
      if (o) {
        group = g;
        orientation = o;
        break;
      }
    }

    // Align this item's names to the group's A/B slots before using them -
    // a source can list "away vs home" while the group canonically stores
    // "home vs away"; comparing unaligned sides corrupts both slots (two
    // different sources each contributing the same team to *opposite*
    // slots produces a "Team X vs Team X" result).
    const [itemA, itemB] = orientation === 'swapped' ? [item.teamB, item.teamA] : [item.teamA, item.teamB];

    if (!group) {
      group = {
        sport: item.sport,
        teamA: item.teamA,
        teamB: item.teamB,
        keyA: item.keyA,
        keyB: item.keyB,
        sources: [],
      };
      groups.push(group);
    } else {
      if (group.sport === 'Other' && item.sport !== 'Other') {
        group.sport = item.sport; // prefer the more specific classification
      }
      // Shortest surviving name is usually the cleanest extraction - other
      // sources for the same game often carry residual qualifier/broadcast
      // text a particular line's punctuation happened to dodge stripping.
      if (itemA.length < group.teamA.length) group.teamA = itemA;
      if (itemB.length < group.teamB.length) group.teamB = itemB;
    }

    group.sources.push({ streamId: item.streamId, icon: item.icon, label: item.sourceName, quality: item.quality });
  }

  return groups.map((g) => ({
    id: hashId(['event', g.keyA, g.keyB]),
    status: 'unknown',
    start: null,
    ...g,
  }));
}

// Finds the ESPN schedule entry (if any) for this matchup. ESPN is the sole
// source of truth for live/upcoming state - IPTV channel-name text is only
// good for finding *that* a game exists and *where* to watch it.
//
// Restricted to the same sport when we already have a specific guess for
// one (both for speed - tennis alone can put 1000+ matches in the schedule
// - and correctness: a soccer team's name has no business matching against
// a tennis player). A group still stuck at 'Other' gets no such guess, so
// it's allowed to scan everything for a chance at being identified at all.
function findEspnMatch(group, schedule) {
  for (const ev of schedule) {
    if (group.sport !== 'Other' && ev.sport !== group.sport) continue;
    const matches =
      samePairing(group.keyA, ev.keyA, group.keyB, ev.keyB) ||
      samePairing(group.keyA, ev.altKeyA, group.keyB, ev.altKeyB) ||
      samePairing(group.keyA, ev.keyA, group.keyB, ev.altKeyB) ||
      samePairing(group.keyA, ev.altKeyA, group.keyB, ev.keyB);
    if (matches) return ev;
  }
  return null;
}

const ORIENTATION_THRESHOLD = 0.72; // matches samePairing's default

// Which side of the ESPN match is our group's teamA? findEspnMatch only
// confirms *a* match exists (checking direct/swapped and short/full name
// combinations internally) without saying which orientation won, and
// assuming "direct" would sometimes hand teamA's logo to teamB's poster slot.
function espnSideForTeamA(group, espn) {
  const matchesHome = similarity(group.keyA, espn.keyA) >= ORIENTATION_THRESHOLD || similarity(group.keyA, espn.altKeyA) >= ORIENTATION_THRESHOLD;
  const matchesAway = similarity(group.keyA, espn.keyB) >= ORIENTATION_THRESHOLD || similarity(group.keyA, espn.altKeyB) >= ORIENTATION_THRESHOLD;
  return matchesAway && !matchesHome ? 'away' : 'home';
}

function applyEspnSchedule(groups, schedule) {
  if (!schedule.length) return groups;
  return groups.map((g) => {
    const espn = findEspnMatch(g, schedule);
    if (!espn) return g;
    const swapped = espnSideForTeamA(g, espn) === 'away';
    return {
      ...g,
      sport: espn.sport, // ESPN's classification is authoritative, overriding our text-based guess
      league: espn.league,
      start: espn.start,
      status: espn.status,
      venue: espn.venue,
      venueCity: espn.venueCity,
      espnBroadcastNames: espn.broadcastNames || [],
      logoA: swapped ? espn.logoB : espn.logoA,
      logoB: swapped ? espn.logoA : espn.logoB,
      espnMatched: true,
    };
  });
}

// ESPN is the only source of live/upcoming truth now: a matchup that ESPN
// doesn't confirm as live or starting soon simply isn't shown, no matter how
// confidently the channel name parsed.
function isVisibleNow(ev, now = Date.now(), windowMs = UPCOMING_WINDOW_MS) {
  if (ev.status === 'live') return true;
  if (ev.status === 'upcoming') return !!ev.start && ev.start - now <= windowMs;
  return false; // 'unknown' (no ESPN match) or 'ended'
}

// Best quality first (4K/UHD, then FHD, then HD, then SD, then unrated) for
// the Stremio source picker - a stable sort, so sources tied on quality (most
// of them, since many sources never had a quality tag to detect) keep
// whatever order they were discovered in rather than shuffling arbitrarily.
function sortSourcesByQuality(sources) {
  return [...sources].sort((a, b) => (b.quality || 0) - (a.quality || 0));
}

// Matches broadcaster names (from wherever) against the user's own plain
// channel list and attaches any hit as an extra source on the event -
// shared by both the free ESPN-native pass and the throttled TheSportsDB
// one below.
function attachMatchingChannelSources(ev, broadcastNames, channels) {
  if (!broadcastNames.length) return;
  const haveStreamIds = new Set(ev.sources.map((s) => s.streamId));
  for (const name of broadcastNames) {
    const nameKey = normalizeKey(name);
    const match = channels.find(
      (c) => !haveStreamIds.has(c.streamId) && brandMatch(normalizeKey(c.name), nameKey, BROADCAST_MATCH_THRESHOLD)
    );
    if (match) {
      ev.sources.push({ streamId: match.streamId, icon: match.icon, label: match.name, quality: match.quality });
      haveStreamIds.add(match.streamId);
    }
  }
}

// ESPN's own scoreboard response already names the actual broadcaster(s)
// for most US sports ("NBC", "FOX", "Peacock", "BTN", "MLB.TV", regional
// feeds like "YES"/"Marquee Sports Net") - data we're already fetching for
// live status, so this costs nothing extra and runs for every visible event,
// no cap needed.
function enrichWithEspnBroadcastNames(events, channels) {
  if (!channels.length) return;
  for (const ev of events) {
    if (!isVisibleNow(ev) || !ev.espnBroadcastNames?.length) continue;
    attachMatchingChannelSources(ev, ev.espnBroadcastNames, channels);
  }
}

// TheSportsDB knows the real-world *international* broadcasters for a game
// ("beIN Sports 1", "Movistar Liga de Campeones", ...) that ESPN's US-centric
// broadcasts field above doesn't cover - matching those against the user's
// channel list finds sources our own channel-name/EPG parsing and the ESPN
// pass above both missed. Only run for events ESPN already confirmed worth
// showing, since there's no point enriching something that's filtered out.
//
// All actual HTTP requests are serialized behind a shared rate limiter in
// sportsdb/client.js (the free test key 429s almost immediately under any
// concurrency), so this is capped to a handful of events per catalog build -
// NFL/NCAAF first since they're prioritized - rather than trying to enrich
// everything visible in one burst. getBroadcastChannelNames caches for an
// hour, so repeat builds fill in more of the catalog as the cache warms up.
const SPORTSDB_MAX_PER_BUILD = 12;

async function enrichWithBroadcastSources(events, channels) {
  const visible = events
    .filter((e) => isVisibleNow(e))
    .sort((a, b) => (PRIORITY_SPORTS.includes(a.sport) ? 0 : 1) - (PRIORITY_SPORTS.includes(b.sport) ? 0 : 1))
    .slice(0, SPORTSDB_MAX_PER_BUILD);
  if (!visible.length || !channels.length) return;

  for (const ev of visible) {
    try {
      const broadcastNames = await getBroadcastChannelNames(ev.teamA, ev.teamB);
      attachMatchingChannelSources(ev, broadcastNames, channels);
    } catch {
      // best-effort enrichment only - never fail the catalog build over it
    }
  }
}

// Channel names that are just a numbered/generic slot, not a real network
// identity - "NCAAF 37", "NFL Game Pass 5 :", "(TTV) - TENNIS TV - EVENT 3",
// "CA | No Event", "NFL | 01 -". A provider reuses these to show a
// *different* specific game each time depending on what's scheduled; on
// their own they tell a browsing user nothing, so once slot-matching below
// has had its chance to attach them to the actual game they're showing,
// whatever's left unmatched gets dropped from the plain channel list
// entirely rather than cluttering it with dozens of "NCAAB 14"-style rows.
const GENERIC_SLOT_CHANNEL_PATTERNS = [
  /\bno\s*(scheduled\s*)?event\b/i,
  /\bevent\s*\d+\b/i, // "TENNIS TV - EVENT 3", "ROLAND GARROS (EVENT 1) Full" - not anchored, trailing words like "Full" are common
  /\bgame\s*pass\s*\d*\s*:?\s*-?\s*$/i,
  // leading [:|-] tolerated - some feeds leave one behind after stripNoise
  // strips a preceding brand fragment ("... :NBA 08" -> ":NBA 08")
  /^\s*[:|\-]*\s*(nfl|ncaaf|ncaab|nba|nhl|mlb|wnba)?\s*\|?\s*\d{1,3}\s*[:.\-–]*\s*$/i,
  // "End | NFL Matchup | NFL Game Pass | CA" - a slot's generic placeholder
  // label between real assignments, not an actual team/network name.
  /^\s*(end|next|live)\s*\|\s*(nfl|ncaaf|ncaab|nba|nhl|mlb|wnba)?\s*matchup\s*(\|.*)?$/i,
];

// Provider category data is sometimes just wrong - a live example: a "GR |
// Food Network" channel sitting inside this panel's own "NCAAB" category,
// icon and all. Nothing about a channel's own text says "sports" or "not
// sports" in general, but a short list of unmistakably-unrelated general-
// entertainment brands that would never legitimately appear in a sport
// category is a safe, narrow defense against that class of mistagging.
const NON_SPORT_BRAND_RE = /\b(food network|cartoon network|cnn|discovery channel|hgtv|nickelodeon|disney channel|comedy central|mtv|vh1)\b/i;

function looksLikeGenericSlotChannel(name) {
  const n = (name || '').trim();
  return !n || NON_SPORT_BRAND_RE.test(n) || GENERIC_SLOT_CHANNEL_PATTERNS.some((re) => re.test(n));
}

// A team name appearing verbatim inside the channel's own name is a strong,
// safe signal on its own ("NFL TEAMS: CBS Patriots (WBZ)" naming the
// Patriots directly) - no EPG needed. Length-gated to avoid short/generic
// team nicknames matching by pure coincidence.
function channelNameMentionsTeam(channelNameKey, teamKey) {
  return teamKey.length >= 4 && channelNameKey.includes(teamKey);
}

// The EPG's own idea of what's airing - a generic sport label plus a venue
// in the description ("College Football" / "From Kyle Field in College
// Station, Texas") - matched against ESPN's per-game venue. This is the
// same mechanism local-affiliate matching used before, just no longer
// restricted to categories literally named "local": a "NFL Game Pass 5"
// slot channel needs the exact same treatment.
function channelEpgMentionsVenue(epgTextKey, ev) {
  return (ev.venue && epgTextKey.includes(normalizeKey(ev.venue))) || (ev.venueCity && epgTextKey.includes(normalizeKey(ev.venueCity)));
}

// Tries to attach every channel that never became an 'event' item to
// whichever live-or-scheduled-ahead game it actually belongs to (by name or
// by EPG venue), then drops whatever's left that's just placeholder/slot
// noise - keeping only channels that read as a real, standalone network.
//
// Deliberately status-based (live/upcoming per ESPN), not gated by the
// upcoming-window time cutoff the catalog listing itself uses: this result
// is cached and shared across every install of this same Xtream account,
// each of which can have its own window setting, so there's no single
// "right now" cutoff to bake in here. A team channel should attach to that
// team's next scheduled game no matter how far off it is - the window only
// controls when the *event* enters the visible catalog, not whether the
// channel is considered part of it.
// A team's nickname is normally the last word of its ESPN display name
// ("Buffalo Bills" -> "Bills", "Ohio State Buckeyes" -> "Buckeyes") - good
// enough to recognize a channel that names that team ("NFL | Bills") without
// needing the channel to spell out the full city+nickname combination.
// IPTV panels are frequently years out of date on team rebrands - ESPN only
// knows the current name, so a legacy nickname needs a manual bridge here.
const LEGACY_TEAM_NICKNAMES = {
  commanders: 'redskins', // Washington's former name, still common on older panels
};

function teamNicknames(fullName) {
  const words = fullName.trim().split(/\s+/);
  const current = words[words.length - 1] || fullName;
  const legacy = LEGACY_TEAM_NICKNAMES[current.toLowerCase()];
  return legacy ? [current, legacy] : [current];
}

async function enrichAndFilterChannels(events, channels) {
  const visible = events.filter((e) => e.status === 'live' || e.status === 'upcoming');

  // For leagues with a full roster available (NFL/NCAAF/NBA/NCAAB), a
  // channel naming a specific team ("NFL | Seahawks", "NFL TEAMS: CBS
  // Patriots...") only makes sense to show while that team actually has a
  // live/upcoming game - otherwise it's a dead entry with nothing behind
  // it, so it's hidden rather than left sitting in the channel list. This
  // doesn't apply to generic, non-team-specific channels (NFL Network, Sky
  // Sports NFL, NFL Redzone) - those aren't "playing" or not, they're just
  // always-on networks, so they stay browsable regardless.
  const rosterSports = [...new Set(channels.map((c) => c.sport))].filter((s) => FAVORITE_TEAM_SPORTS.includes(s));
  const rosters = {};
  await Promise.all(
    rosterSports.map(async (sport) => {
      rosters[sport] = await getTeams(sport).catch(() => []);
    })
  );

  const kept = [];

  for (const ch of channels) {
    const nameKey = normalizeKey(ch.name);
    const epgTextKey = ch.epgText ? normalizeKey(ch.epgText) : '';
    const target = visible.find(
      (ev) =>
        ev.sport === ch.sport &&
        !ev.sources.some((s) => s.streamId === ch.streamId) &&
        ((epgTextKey && channelEpgMentionsVenue(epgTextKey, ev)) ||
          channelNameMentionsTeam(nameKey, normalizeKey(ev.teamA)) ||
          channelNameMentionsTeam(nameKey, normalizeKey(ev.teamB)))
    );

    if (target) {
      target.sources.push({ streamId: ch.streamId, icon: ch.icon, label: ch.name, quality: ch.quality });
      continue; // now surfaced as an event source - not also listed standalone
    }

    const roster = rosters[ch.sport];
    if (
      roster?.length &&
      roster.some((t) => teamNicknames(t.name).some((n) => channelNameMentionsTeam(nameKey, normalizeKey(n))))
    ) {
      continue; // names a real team that isn't currently playing - hide
    }

    if (looksLikeGenericSlotChannel(ch.name)) continue; // unmatched placeholder noise - drop
    kept.push(ch);
  }

  return kept;
}

async function buildCatalogData(xtreamClient) {
  const [items, schedule] = await Promise.all([
    buildRawItems(xtreamClient),
    getSchedule().catch(() => []),
  ]);
  let events = groupEvents(items.filter((i) => i.type === 'event'));
  events = applyEspnSchedule(events, schedule);
  let channels = items
    .filter((i) => i.type === 'channel')
    .map((c) => ({ id: hashId(['channel', String(c.streamId)]), ...c }));
  channels = await enrichAndFilterChannels(events, channels);
  enrichWithEspnBroadcastNames(events, channels);
  await enrichWithBroadcastSources(events, channels).catch(() => {});
  return { events, channels, builtAt: Date.now() };
}

module.exports = {
  buildCatalogData,
  buildRawItems,
  groupEvents,
  isVisibleNow,
  applyEspnSchedule,
  findEspnMatch,
  sortSourcesByQuality,
};
