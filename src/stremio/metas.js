const { PRIORITY_SPORTS } = require('../matching/sportTaxonomy');

const SPORT_ICON = {
  NBA: '🏀',
  NCAAB: '🏀',
  Football: '⚽',
  'American Football': '🏈',
  NCAAF: '🏈',
  Hockey: '🏒',
  Baseball: '⚾',
  'Motor Sports': '🏎️',
  Fight: '🥊',
  Tennis: '🎾',
  Rugby: '🏉',
  Golf: '⛳',
  Billiards: '🎱',
  AFL: '🏉',
  Darts: '🎯',
  Cricket: '🏏',
  Other: '📺',
};

const LEAGUE_LABELS = {
  'eng.1': 'Premier League',
  'esp.1': 'LaLiga',
  'ger.1': 'Bundesliga',
  'ita.1': 'Serie A',
  'fra.1': 'Ligue 1',
  'uefa.champions': 'Champions League',
  'uefa.europa': 'Europa League',
  'usa.1': 'MLS',
  nba: 'NBA',
  wnba: 'WNBA',
  'mens-college-basketball': 'NCAAB',
  'womens-college-basketball': "NCAAB (Women's)",
  nfl: 'NFL',
  'college-football': 'NCAAF',
  nhl: 'NHL',
  mlb: 'MLB',
  ufc: 'UFC',
  afl: 'AFL',
  atp: 'ATP',
  wta: 'WTA',
};

// Formats against a named IANA zone (via Intl, which knows the DST rules)
// rather than a fixed minutes-offset baked in at config time - a game's
// displayed kickoff time stays correct across a DST transition instead of
// silently drifting an hour.
function fmtTime(ms, timezone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(
      new Date(ms)
    );
  }
}

function eventName(ev, config) {
  if (config.hideTitles) return `${SPORT_ICON[ev.sport] || ''} ${ev.sport}`.trim();
  // Only claim LIVE when it's confirmed (ESPN or EPG) - an unverified
  // channel-name match just shows plain, no badge, no guessed kickoff time.
  let prefix = '';
  if (ev.status === 'live') prefix = '🔴 LIVE';
  else if (ev.status === 'upcoming' && ev.start) prefix = fmtTime(ev.start, config.timezone);
  const base = `${ev.teamA} vs ${ev.teamB}`;
  return prefix ? `${prefix} · ${base}` : base;
}

function fmtDateTime(ms, timezone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toUTCString();
  }
}

function eventDescription(ev, config) {
  if (config.hideDescriptions) return undefined;
  const parts = [ev.league ? LEAGUE_LABELS[ev.league] || ev.league : ev.sport];
  if (ev.status === 'unknown') parts.push('timing unverified');
  else if (ev.start) parts.push(fmtDateTime(ev.start, config.timezone));
  parts.push(`${ev.sources.length} source${ev.sources.length === 1 ? '' : 's'} available`);
  return parts.join(' · ');
}

// Team logos (from ESPN) make a far better poster than whichever random
// broadcast channel's icon happened to be first - rendered as an SVG so
// there's no image-compositing dependency, with a text-only "Team A vs Team
// B" card as the fallback when a logo isn't available for one or both sides.
function eventPosterUrl(ev, baseUrl) {
  if (!baseUrl) return ev.sources.find((s) => s.icon)?.icon || undefined;
  const params = new URLSearchParams({ a: ev.teamA, b: ev.teamB, sport: ev.sport });
  if (ev.logoA) params.set('logoA', ev.logoA);
  if (ev.logoB) params.set('logoB', ev.logoB);
  return `${baseUrl}/poster/event.svg?${params.toString()}`;
}

function eventToMetaPreview(ev, config, baseUrl) {
  return {
    id: `xiptv-event-${ev.id}`,
    type: 'tv',
    name: eventName(ev, config),
    poster: eventPosterUrl(ev, baseUrl),
    posterShape: 'landscape',
    description: eventDescription(ev, config),
    genres: [ev.sport],
    releaseInfo: ev.status === 'live' ? 'LIVE' : undefined,
  };
}

function eventToMetaDetail(ev, config, baseUrl) {
  const preview = eventToMetaPreview(ev, config, baseUrl);
  return { ...preview, background: preview.poster };
}

function channelToMetaPreview(ch, config) {
  return {
    id: `xiptv-channel-${ch.id}`,
    type: 'tv',
    name: config.hideTitles ? `${SPORT_ICON[ch.sport] || ''} ${ch.sport}`.trim() : ch.name,
    poster: ch.icon || undefined,
    posterShape: 'square',
    description: config.hideDescriptions ? undefined : ch.sport,
    genres: [ch.sport],
  };
}

function channelToMetaDetail(ch, config) {
  return { ...channelToMetaPreview(ch, config), background: ch.icon || undefined };
}

// live first, then soonest upcoming; NFL/NCAAF prioritized within each tier,
// most-sourced first as a final tiebreak.
function sortEvents(events) {
  const statusRank = { live: 0, upcoming: 1, unknown: 2 };
  const sportRank = (s) => (PRIORITY_SPORTS.includes(s) ? 0 : 1);
  return [...events].sort((a, b) => {
    const r1 = (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3);
    if (r1 !== 0) return r1;
    const r2 = sportRank(a.sport) - sportRank(b.sport);
    if (r2 !== 0) return r2;
    if (a.start && b.start) return a.start - b.start;
    return (b.sources?.length || 0) - (a.sources?.length || 0);
  });
}

module.exports = { eventToMetaPreview, eventToMetaDetail, channelToMetaPreview, channelToMetaDetail, sortEvents };
