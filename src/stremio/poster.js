// Generates a matchup poster on the fly as SVG - no image-processing
// dependency needed (no canvas/sharp, no native build step). logoA/logoB are
// expected to already be data: URIs (see server.js's fetchLogoDataUri) - a
// browser loading this SVG as an <img>/background-image ("image context")
// refuses to fetch any *external* resource referenced from inside it, so a
// plain https:// <image href> here would just render blank; embedding the
// bytes directly sidesteps that restriction entirely. Falls back to a
// text-only card (team names + "VS" on a sport-colored background) when
// ESPN didn't give us one or both logos.
const SPORT_COLORS = {
  'American Football': '#7c2d12',
  NCAAF: '#78350f',
  NBA: '#c2410c',
  NCAAB: '#9a3412',
  Football: '#166534',
  Hockey: '#1e3a8a',
  Baseball: '#991b1b',
  'Motor Sports': '#374151',
  Fight: '#7f1d1d',
  Tennis: '#4d7c0f',
  Rugby: '#3f6212',
  Golf: '#14532d',
  Billiards: '#1e3a8a',
  AFL: '#b45309',
  Darts: '#312e81',
  Cricket: '#166534',
  Other: '#334155',
};

const WIDTH = 600;
const HEIGHT = 400;

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Naive two-line wrap for team names too long to fit on one line.
function wrapLines(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const words = text.split(' ');
  let line1 = '';
  let line2 = '';
  for (const w of words) {
    if (!line2 && (line1 ? `${line1} ${w}` : w).length <= maxChars) line1 = line1 ? `${line1} ${w}` : w;
    else line2 = line2 ? `${line2} ${w}` : w;
  }
  return line2 ? [line1, line2] : [line1];
}

function nameBlock(text, x, y, fontSize) {
  const lines = wrapLines(text, 18);
  const lineHeight = fontSize * 1.15;
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines.map((l, i) => `<tspan x="${x}" y="${startY + i * lineHeight}">${escapeXml(l)}</tspan>`).join('');
  return `<text font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff" text-anchor="middle">${tspans}</text>`;
}

function textOnlyPoster(teamA, teamB, sport) {
  const bg = SPORT_COLORS[sport] || SPORT_COLORS.Other;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<rect width="${WIDTH}" height="${HEIGHT}" fill="${bg}"/>
${nameBlock(teamA, WIDTH / 2, 130, 38)}
<text x="${WIDTH / 2}" y="${HEIGHT / 2 + 10}" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700" fill="#ffffffb3" text-anchor="middle">VS</text>
${nameBlock(teamB, WIDTH / 2, 280, 38)}
</svg>`;
}

function logoPoster(teamA, teamB, logoA, logoB, sport) {
  const bg = SPORT_COLORS[sport] || SPORT_COLORS.Other;
  const logoSize = 190;
  const logoY = (HEIGHT - logoSize) / 2 - 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<rect width="${WIDTH}" height="${HEIGHT}" fill="${bg}"/>
<image x="45" y="${logoY}" width="${logoSize}" height="${logoSize}" href="${escapeXml(logoA)}" preserveAspectRatio="xMidYMid meet"/>
<text x="${WIDTH / 2}" y="${HEIGHT / 2 + 8}" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">VS</text>
<image x="${WIDTH - 45 - logoSize}" y="${logoY}" width="${logoSize}" height="${logoSize}" href="${escapeXml(logoB)}" preserveAspectRatio="xMidYMid meet"/>
</svg>`;
}

function buildPosterSvg({ teamA, teamB, logoA, logoB, sport }) {
  if (logoA && logoB) return logoPoster(teamA, teamB, logoA, logoB, sport);
  return textOnlyPoster(teamA, teamB, sport);
}

module.exports = { buildPosterSvg };
