const { SPORTS, FAVORITE_TEAM_SPORTS } = require('./matching/sportTaxonomy');

// Curated for the /configure dropdown - standardized IANA names rather than
// raw UTC offsets, so "Eastern Time (New York)" reads the same in July and
// January even though the actual UTC offset shifts with DST. The value is
// the IANA zone; kickoff times are formatted against it live (see
// stremio/metas.js), so the display stays DST-correct automatically instead
// of going stale the way a fixed minutes-offset baked in at config time would.
const TIMEZONES = [
  { value: 'Pacific/Honolulu', label: 'Hawaii Time (Honolulu)' },
  { value: 'America/Anchorage', label: 'Alaska Time (Anchorage)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (Los Angeles)' },
  { value: 'America/Denver', label: 'Mountain Time (Denver)' },
  { value: 'America/Phoenix', label: 'Mountain Time, no DST (Phoenix)' },
  { value: 'America/Chicago', label: 'Central Time (Chicago)' },
  { value: 'America/New_York', label: 'Eastern Time (New York)' },
  { value: 'America/Halifax', label: 'Atlantic Time (Halifax)' },
  { value: 'America/Sao_Paulo', label: 'Brasília Time (São Paulo)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'UK Time (London)' },
  { value: 'Europe/Paris', label: 'Central European Time (Paris)' },
  { value: 'Europe/Athens', label: 'Eastern European Time (Athens)' },
  { value: 'Africa/Cairo', label: 'Egypt Time (Cairo)' },
  { value: 'Asia/Dubai', label: 'Gulf Time (Dubai)' },
  { value: 'Asia/Kolkata', label: 'India Time (Kolkata)' },
  { value: 'Asia/Shanghai', label: 'China Time (Shanghai)' },
  { value: 'Asia/Tokyo', label: 'Japan Time (Tokyo)' },
  { value: 'Australia/Sydney', label: 'Australian Eastern Time (Sydney)' },
  { value: 'Pacific/Auckland', label: 'New Zealand Time (Auckland)' },
];
const DEFAULT_TIMEZONE = 'UTC';
const MIN_UPCOMING_WINDOW_HOURS = 0.5;
const MAX_UPCOMING_WINDOW_HOURS = 24;
const DEFAULT_UPCOMING_WINDOW_HOURS = 3;

function normalizeFavoriteTeams(input) {
  const result = {};
  if (!input || typeof input !== 'object') return result;
  for (const sport of FAVORITE_TEAM_SPORTS) {
    const list = input[sport];
    if (!Array.isArray(list)) continue;
    const cleaned = [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
    if (cleaned.length) result[sport] = cleaned;
  }
  return result;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Config travels inside the install URL itself (base64url JSON), the same
// pattern Stremio addons commonly use for per-install settings - no server
// side accounts/DB needed.
function encodeConfig(cfg) {
  const json = JSON.stringify(cfg);
  return Buffer.from(json, 'utf8').toString('base64url');
}

function decodeConfig(str) {
  const json = Buffer.from(str, 'base64url').toString('utf8');
  const cfg = JSON.parse(json);
  return normalizeConfig(cfg);
}

function normalizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('Invalid config');
  const server = String(cfg.server || '').trim().replace(/\/+$/, '');
  const username = String(cfg.username || '').trim();
  const password = String(cfg.password || '').trim();
  if (!server || !username || !password) {
    throw new Error('Xtream server, username and password are required');
  }
  const sports = Array.isArray(cfg.sports)
    ? cfg.sports.filter((s) => SPORTS.includes(s))
    : [];
  const upcomingWindowHours = Number.isFinite(cfg.upcomingWindowHours)
    ? Math.min(MAX_UPCOMING_WINDOW_HOURS, Math.max(MIN_UPCOMING_WINDOW_HOURS, cfg.upcomingWindowHours))
    : DEFAULT_UPCOMING_WINDOW_HOURS;
  return {
    server,
    username,
    password,
    liveOnly: !!cfg.liveOnly,
    hideTitles: !!cfg.hideTitles,
    hideDescriptions: !!cfg.hideDescriptions,
    proxyStreams: !!cfg.proxyStreams,
    sports, // empty = all sports
    timezone: isValidTimezone(cfg.timezone) ? cfg.timezone : DEFAULT_TIMEZONE,
    upcomingWindowHours,
    favoriteTeams: normalizeFavoriteTeams(cfg.favoriteTeams), // { [sport]: string[] }
  };
}

module.exports = {
  encodeConfig,
  decodeConfig,
  normalizeConfig,
  TIMEZONES,
  DEFAULT_TIMEZONE,
  MIN_UPCOMING_WINDOW_HOURS,
  MAX_UPCOMING_WINDOW_HOURS,
  DEFAULT_UPCOMING_WINDOW_HOURS,
};
