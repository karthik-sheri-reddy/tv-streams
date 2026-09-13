const { SPORTS, PRIORITY_SPORTS, FAVORITE_TEAM_SPORTS, sportSlug } = require('../matching/sportTaxonomy');

// Each sport is its own Stremio catalog (a "NFL" row, an "NCAAF" row, ...)
// rather than one shared "Sports Events" catalog filtered by a genre extra -
// selecting a sport is then just picking which catalog to look at, the way
// Stremio's own catalog dropdown already works. Events and channels for that
// sport are combined into one list (see server.js's handleCatalog).
function buildManifest(config) {
  const allowed = config.sports.length ? new Set(config.sports) : null;
  const sports = SPORTS.filter((s) => !allowed || allowed.has(s));
  // priority sports (NFL/NCAAF/NBA/NCAAB) first, matching the sort order used elsewhere
  const ordered = [...PRIORITY_SPORTS.filter((s) => sports.includes(s)), ...sports.filter((s) => !PRIORITY_SPORTS.includes(s))];

  const catalogs = ordered.map((sport) => {
    const extra = [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false },
    ];
    // Only offer the Favorites filter where the user actually picked favorite
    // teams for this league in /configure - no point showing an option that
    // would just return "no results" every time.
    if (FAVORITE_TEAM_SPORTS.includes(sport) && config.favoriteTeams[sport]?.length) {
      extra.unshift({ name: 'genre', options: ['All Games', 'Favorites'], isRequired: false });
    }
    return { type: 'tv', id: `xiptv-sport-${sportSlug(sport)}`, name: sport, extra };
  });

  return {
    id: 'org.personal.xtream.sports',
    version: '1.1.0',
    name: 'My IPTV Sports',
    description: 'Live sports events and channels matched from your personal Xtream Codes IPTV, grouped by sport with fuzzy matchup detection from channel names and EPG data.',
    logo: 'https://raw.githubusercontent.com/twbs/icons/main/icons/badge-tv.svg',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    idPrefixes: ['xiptv-'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

module.exports = { buildManifest };
