// Same taxonomy as the reference addon (14 sports + "Other"), with NCAAF
// split out of "American Football" (NFL), and NCAAB split out of "NBA", each
// as its own category - both pairs listed first since they're prioritized.
const SPORTS = [
  'American Football',
  'NCAAF',
  'NBA',
  'NCAAB',
  'Football',
  'Hockey',
  'Baseball',
  'Motor Sports',
  'Fight',
  'Tennis',
  'Rugby',
  'Golf',
  'Billiards',
  'AFL',
  'Darts',
  'Cricket',
  'Other',
];

// Sports listed/sorted first in catalogs and configure chips.
const PRIORITY_SPORTS = ['American Football', 'NCAAF', 'NBA', 'NCAAB'];

// Leagues the /configure "Favorite Teams" picker offers, and the ones whose
// per-sport catalog gets a "Favorites" genre option (see stremio/manifest.js).
const FAVORITE_TEAM_SPORTS = ['American Football', 'NCAAF', 'NBA', 'NCAAB'];

// Each sport gets its own Stremio catalog (see stremio/manifest.js) rather
// than one shared catalog filtered by a "genre" extra - these convert
// between the sport's display name and a URL/id-safe slug for that.
function sportSlug(sport) {
  return sport.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

const SPORT_BY_SLUG = new Map(SPORTS.map((s) => [sportSlug(s), s]));

function sportFromSlug(slug) {
  return SPORT_BY_SLUG.get(slug) || null;
}

// Categories that merely contain a sport-ish word but are not sport content.
const EXCLUDE_PATTERNS = [/\bbox\s*office\b/i, /\bboxset\b/i];

// Checked in order; first match wins. Word-boundary patterns to avoid
// substring false positives (e.g. "box" inside "BOX OFFICE").
const SPORT_PATTERNS = [
  // Checked before the generic NFL pattern so "college football"/"NCAAF"
  // never falls into the NFL bucket.
  // Matches "NCAAF", "College Football", "CFB", and "NCAA Football" in any
  // of its real-world spellings ("NCAA Football", "NCAA - Football",
  // "NCAA: Football", "Fútbol Americano NCAA") - broadcasters rarely write
  // just "college football" outright.
  ['NCAAF', /\bncaaf\b|\bcfb\b|college\s*football|ncaa\s*[-:]?\s*football|f[uú]tbol\s*americano\s*ncaa/i],
  ['American Football', /\b(nfl|cfl|american\s*football|redzone|red\s*zone)\b/i],
  ['AFL', /\bafl\b/i],
  // Checked before the generic NBA pattern so "NCAAB"/"college basketball"
  // never falls into the NBA bucket.
  ['NCAAB', /\bncaab\b|college\s*basketball|ncaa\s*[-:]?\s*basketball/i],
  ['NBA', /\b(nba|wnba|basketball|euroleague)\b/i],
  ['Hockey', /\b(nhl|ahl|ohl|whl|qmjhl|ice\s*hockey|\bhockey\b)\b/i],
  ['Baseball', /\b(mlb|milb|baseball)\b/i],
  ['Fight', /\b(ufc|mma|boxing|bkfc|glory|wwe|aew|wrestling|bellator|ppv\s*event|triller\s*tv)\b/i],
  ['Tennis', /\b(tennis|atp|wta|roland[\s-]?garros|wimbledon)\b/i],
  ['Rugby', /\b(rugby|nrl|six\s*nations|super\s*rugby|super\s*league)\b/i],
  ['Golf', /\b(golf|pga|ryder\s*cup)\b/i],
  ['Billiards', /\b(billiards?|snooker|pool)\b/i],
  ['Darts', /\b(darts|pdc)\b/i],
  ['Cricket', /\b(cricket|ipl\b|willow)\b/i],
  ['Motor Sports', /\b(f1|formula\s*1|motogp|nascar|motor\s*sports?|indycar|rally)\b/i],
  [
    'Football',
    // footb+all tolerates the "FOOTBBALL" typo seen on some panels
    /\b(footb+all|soccer|premier\s*league|la\s*liga|laliga|bundesliga|serie\s*a|ligue\s*1|ligue\s*(\+|plus)|uefa|champions\s*league|europa\s*league|\bmls\b|fifa|national\s*league|wc\s*20\d\d)\b/i,
  ],
];

// Brand/keyword hints that mean "this is sports content" without telling us
// which specific sport - used at category level so we still walk in and
// classify individual channels/events by name or EPG title.
const GENERIC_SPORT_PATTERNS = [
  /\bsport(s)?\b/i,
  /\bppv\b/i,
  /\bpay\s*per\s*view\b/i,
  // "EVENTS" on a *live-TV* category is overwhelmingly PPV/sports content
  // ("Amazon Prime Events", "Viaplay Event", "TSN+ Event", "Paramount+
  // Event", ...) - and anything this pulls in still has to parse to a
  // matchup and get confirmed by ESPN before it's ever shown, so a stray
  // non-sports "events" category costs nothing worse than an unused entry
  // in the plain channel list.
  /\bevents?\b/i,
  /\b[ée]v[ée]nement\b/i, // French spelling of "event"
  /\bdazn\b/i,
  /\bbein\b/i,
  /\beurosport\b/i,
  /\bespn\b/i,
  /\bsportsnet\b/i,
  /\bfanduel\b/i,
  /\bbally\s*sports\b/i,
  /\bflosports\b/i,
  /\bflo\s*(sports?|flsp|racing)\b/i,
  /\bparamount\+?\b/i,
  /\bpeacock\b/i,
  /\btsn\+?\b/i,
  /\bsec\s*network\b/i,
];

function isExcluded(text) {
  return EXCLUDE_PATTERNS.some((re) => re.test(text));
}

// Weak signal, checked last: club-name conventions used almost exclusively
// by soccer clubs (esp. lower-league/regional ones that never mention
// "football" or a named competition, e.g. "Western Springs AFC", "FK Kukësi").
// Deliberately excludes generic words like "united"/"city" (false-positives
// on "United States", "Kansas City", etc.) - only club-suffix abbreviations
// that are essentially never used outside soccer club names.
const FOOTBALL_CLUB_HINT_RE = /\b(fc|afc|cf|fk|cd|sk|calcio|rovers|wanderers)\b/i;

function classifyText(text) {
  if (!text || isExcluded(text)) return null;
  for (const [sport, re] of SPORT_PATTERNS) {
    if (re.test(text)) return sport;
  }
  if (FOOTBALL_CLUB_HINT_RE.test(text)) return 'Football';
  return null;
}

// Returns a sport name, 'Other' (generic sports content, sport unknown yet),
// or null (not sports at all).
function classifyCategory(categoryName) {
  if (!categoryName || isExcluded(categoryName)) return null;
  const specific = classifyText(categoryName);
  if (specific) return specific;
  if (GENERIC_SPORT_PATTERNS.some((re) => re.test(categoryName))) return 'Other';
  return null;
}

module.exports = {
  SPORTS,
  PRIORITY_SPORTS,
  FAVORITE_TEAM_SPORTS,
  classifyCategory,
  classifyText,
  isExcluded,
  sportSlug,
  sportFromSlug,
};
