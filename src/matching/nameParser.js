// Turns messy Xtream channel/EPG-programme names into structured matchup
// data. Real examples this has to survive (pulled from a live panel):
//   "NFL  | 03 - 1pm Buccaneers at Bengals"
//   "NBA Summer League Mavericks vs. Thunder Jul 16 :NBA 01"
//   "|US| UFC EVENT" / "MA | No Event" / "NBA EVENT"          -> placeholders
//   "San Francisco 49ers vs. Los Angeles Rams"                -> EPG title

const COUNTRY_TAG_RE = /\|\s*[A-Z]{2,4}\s*\|/g;
// Stylized unicode HD/UHD/FHD/4K variants (superscript letters) some panels
// use in channel names, plus the plain-ASCII forms.
const QUALITY_RE = /\b(4k|uhd|fhd|hd|sd)\b|[ᴬ-ᵪ⁰-₟]+/gi;
const LEADING_INDEX_RE = /^\s*(?:[A-Za-z][\w .]{0,20}?)?\b\d{1,3}\s*[:.\-]\s*/;
const JUNK_PHRASES = [
  'no event streaming',
  'no event',
  'no signal',
  'no stream',
  'off air',
  'offline',
  'coming soon',
  'exclusive',
];
const PLACEHOLDER_RE = /^(event|tbd|test|)$/i;
// A side that's really just a competition/season label, not a second team
// ("Premier League", "Serie A 26/27") - common in poorly-tagged PPV feeds.
const LEAGUE_ONLY_RE = /^(premier league|la ?liga|serie ?a|bundesliga|ligue ?1|champions league|europa league|eredivisie|primeira liga|super lig|nba|nfl|nhl|mlb|ufc)\s*[\d/]*$/i;

function stripNoise(raw) {
  if (!raw) return '';
  let s = raw;
  s = s.replace(COUNTRY_TAG_RE, ' ');
  s = s.replace(QUALITY_RE, ' ');
  s = s.replace(/[✪★]/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

// "A vs B", "A vs. B", "A v B", "A @ B", "A at B", "A - B"
const MATCHUP_RE = /^(.{2,60}?)\s+(?:vs\.?|v\.?|@|at)\s+(.{2,60}?)$/i;
const DASH_MATCHUP_RE = /^(.{2,60}?)\s+-\s+(.{2,60}?)$/;

function looksLikePlaceholder(side) {
  const t = side.trim();
  if (t === '' || PLACEHOLDER_RE.test(t) || /^\d+$/.test(t)) return true;
  const lower = t.toLowerCase();
  if (JUNK_PHRASES.some((p) => lower.includes(p))) return true;
  if (LEAGUE_ONLY_RE.test(t)) return true;
  return false;
}

// Trims a trailing date/time/league-index tail off a matchup side, e.g.
// "Thunder Jul 16 :NBA 01" -> "Thunder"
function trimTrailingNoise(side) {
  return side
    .replace(/\s*\([^()]*\)?\s*$/, '') // trailing "(2026-09-12 16:00:00)", closed or dangling
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b.*/i, '')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b.*/i, '')
    .replace(/[:.].*$/, '')
    .replace(/[\s:@|.\-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function trimLeadingNoise(side) {
  return side.replace(/^[\s:@|.\-]+/, '').trim();
}

// EPG/channel titles often glue a competition/round qualifier onto one side
// with " - ", and the qualifier can land either before or after the real
// team name ("Fulham - English Premier League 2026/2027" vs
// "Liga Premier - Liverpool"). Drop whichever "-"-separated part looks like
// the qualifier rather than always assuming a fixed position.
const QUALIFIER_HINT_RE = /\b(premier league|la ?liga|liga|serie ?a|bundesliga|ligue ?1|champions league|europa league|eredivisie|primeira liga|super lig|week ?\d+|matchday|\bmd ?\d+\b|\d{4}\/\d{2,4}|\d{4}-\d{2,4})\b/i;
// A part that IS entirely just an org/sport name ("NCAA", "Football") rather
// than containing one - multi-word qualifiers like "NCAA - Football -
// Arizona State" chain more than one of these before the real team name.
const ORG_WORD_RE = /^(ncaa|ncaaf|college football|football|soccer|basketball|hockey|baseball|mma|ufc)$/i;

function stripQualifierSegment(side) {
  const parts = side.split(' - ').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return side;
  const nonQualifier = parts.filter((p) => !QUALIFIER_HINT_RE.test(p) && !ORG_WORD_RE.test(p));
  if (nonQualifier.length === 1) return nonQualifier[0];
  if (nonQualifier.length > 1) return nonQualifier[nonQualifier.length - 1]; // last remaining part is closest to the team
  return parts[0];
}

// Extracts a two-participant matchup from free text. Providers often wrap
// the real "Team A vs Team B" in brand/index/date noise separated by "|" or
// ":" (e.g. "DAZN FR 042| Genoa vs. Frosinone | Serie A (2026-09-12)"), so
// try progressively narrower slices of the string rather than requiring the
// whole line to be a clean matchup.
function tryParse(candidate) {
  let m = MATCHUP_RE.exec(candidate);
  if (!m) m = DASH_MATCHUP_RE.exec(candidate);
  if (!m) return null;
  const rawA = trimLeadingNoise(trimTrailingNoise(m[1]));
  const rawB = trimLeadingNoise(trimTrailingNoise(m[2]));
  const teamA = stripQualifierSegment(rawA);
  const teamB = stripQualifierSegment(rawB);
  if (looksLikePlaceholder(teamA) || looksLikePlaceholder(teamB)) return null;
  if (teamA.toLowerCase() === teamB.toLowerCase()) return null;
  // Keep the pre-strip text around too: the stripped-out qualifier
  // ("...- English Premier League 2026/2027") is often the only clue to
  // which sport this actually is, even though it's noise for the team name.
  return { teamA, teamB, sportHint: `${rawA} ${rawB}` };
}

// Broadcast-status words providers prefix onto the line ("Live | Team A vs
// Team B", "End | ...", "Next | 2026-09-12 | ..."). These aren't useful
// noise to fold into a matchup side the way trimTrailingNoise handles - they
// have to go before matching even starts, or "Live" ends up glued to teamA.
const STATUS_PREFIX_RE = /^\s*(live|end(ed)?|next|upcoming|final|ft)\s*[|:]\s*/i;

function extractMatchup(text) {
  if (!text) return null;
  const whole = text.replace(STATUS_PREFIX_RE, '').replace(LEADING_INDEX_RE, '').trim();

  // Field-delimited variants first: providers use "|" to separate brand/
  // index/date fields from the actual matchup, and a segment that isolates
  // just "Team A vs Team B" is far more reliable than letting the regex
  // run loose over the whole line (which happily matches "Live | Strasbourg"
  // as teamA if nothing stops it at the pipe).
  const segments = whole.split('|').map((s) => s.trim()).filter(Boolean);
  if (segments.length > 1) {
    for (const seg of segments) {
      const parsed = tryParse(seg.replace(STATUS_PREFIX_RE, '').replace(LEADING_INDEX_RE, ''));
      if (parsed) return parsed;
    }
  }

  return tryParse(whole);
}

function normalizeKey(str) {
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Quality is deliberately stripped from names before matching (stripNoise
// above) since it's noise for finding/grouping a matchup - but it's real
// signal for ranking *which stream to hand the user first* once a group has
// several sources, so it's read straight off the raw, unstripped name here.
// Many panels stylize quality tags as unicode superscript letters (ᵁᴴᴰ,
// ᴴᴰ) instead of plain ASCII - literal substring checks for those, since \b
// word-boundary regex doesn't apply the same way to non-Latin codepoints.
const QUALITY_RANK_PATTERNS = [
  [4, /\b(4k|uhd|2160p?|ultra)\b/i, 'ᵁᴴᴰ'],
  [3, /\b(fhd|1080p?)\b/i],
  [2, /\b(hd|720p?)\b/i, 'ᴴᴰ'],
  [1, /\b(sd|480p?)\b/i],
];

function detectQualityRank(raw) {
  if (!raw) return 0;
  for (const [rank, re, stylized] of QUALITY_RANK_PATTERNS) {
    if (re.test(raw) || (stylized && raw.includes(stylized))) return rank;
  }
  return 0;
}

module.exports = { stripNoise, extractMatchup, looksLikePlaceholder, normalizeKey, detectQualityRank };
