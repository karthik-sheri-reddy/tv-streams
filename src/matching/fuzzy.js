const levenshtein = require('fast-levenshtein');

// College sports (and some pro leagues) routinely form a completely
// different, real team by adding one of these words to a base name -
// "Texas" and "Texas A&M" (or "Arizona"/"Arizona State", "Miami"/"Miami
// (OH)") are rivals, not two spellings of the same school. Containment
// alone can't tell "AS Monaco" ⊃ "Monaco" (same club, legal-entity prefix)
// apart from "Texas A&M" ⊃ "Texas" (different schools) - but the *extra*
// text can: a known disambiguating qualifier in it means these are two
// distinct teams, not a shortened name, no matter how much text overlaps.
const DISAMBIGUATING_QUALIFIER_RE =
  /\b(state|tech|southern|western|eastern|northern|north|south|east|west|international|christian|baptist|poly|commerce|a\s*m|a\s*t)\b/i;
// Short prefixes/suffixes that are just a club's legal form, not part of its
// identity ("AS Monaco", "FC Barcelona") - safe to ignore. Any OTHER short
// (<=3 char) leftover is treated with suspicion instead of assumed safe: college
// sports commonly disambiguate with a short state code the qualifier list
// above can't enumerate ("Miami (OH)" vs "Miami", extra = "oh") - erring
// toward not merging is the far cheaper mistake than merging two real games.
const SAFE_ORG_AFFIX_RE = /^(as|fc|cf|sc|sk|afc|ac|us|ss|ud|rc|ca|cd)$/i;

// 1.0 = identical, 0.0 = completely different. Treats one name containing
// the other as a strong match ("rams" is very likely "la rams") *unless*
// the extra text looks like a disambiguating qualifier, in which case it's
// very likely a genuinely different team and this falls through to a plain
// edit-distance ratio instead.
function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) {
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    const extra = longer.replace(shorter, '').trim();
    const disambiguating =
      DISAMBIGUATING_QUALIFIER_RE.test(extra) || (extra.length > 0 && extra.length <= 3 && !SAFE_ORG_AFFIX_RE.test(extra));
    if (!disambiguating) return 0.9;
  }
  const dist = levenshtein.get(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

// Are these two "teamA/teamB" pairs (already normalizeKey'd) close enough to
// be the same real-world matchup, allowing for spelling drift between feeds
// ("la rams" vs "los angeles rams")? Order-independent.
function samePairing(a1, a2, b1, b2, threshold = 0.72) {
  return pairingOrientation(a1, b1, a2, b2, threshold) !== null;
}

// Like samePairing, but tells you *which* side matched which - needed
// whenever the two matched sides get used afterward (e.g. picking the
// cleanest team-name variant), since a broadcaster listing "away vs home"
// instead of "home vs away" is a swap, not a mismatch, and treating the
// swapped item's teamA as if it aligned with the group's teamA corrupts the
// pairing (two different sources can each contribute the same team name to
// *opposite* slots, producing a "Team X vs Team X" degenerate result).
// Returns 'direct', 'swapped', or null.
function pairingOrientation(groupA, groupB, itemA, itemB, threshold = 0.72) {
  if (similarity(groupA, itemA) >= threshold && similarity(groupB, itemB) >= threshold) return 'direct';
  if (similarity(groupA, itemB) >= threshold && similarity(groupB, itemA) >= threshold) return 'swapped';
  return null;
}

// A stricter comparator for brand/channel names ("DAZN 1" vs "DAZN 1 Italy",
// "Sky Sports Football" vs "Sky Sports Football HD"). similarity()'s
// mid-string containment check is right for team names (a short nickname is
// very likely the same team) but too loose here: generic channel names like
// "Sports 2" would spuriously "contain-match" almost any broadcaster whose
// name happens to include those words in passing ("Premier Sports 2 IE"),
// which would attach the wrong stream to an event. Only a *prefix* match (one
// name plus a trailing qualifier - country, quality, language) counts as
// containment; anything else falls back to a plain edit-distance ratio with
// no shortcut.
function brandMatch(a, b, threshold = 0.85) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  const dist = levenshtein.get(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen > 0 && 1 - dist / maxLen >= threshold;
}

module.exports = { similarity, samePairing, pairingOrientation, brandMatch };
