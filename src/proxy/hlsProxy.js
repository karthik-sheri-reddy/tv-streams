const crypto = require('crypto');

// Every URL a client can reach through the proxy is one WE fetched first,
// never one a client supplies directly - a raw ?url= passthrough would make
// this server an open relay (SSRF: fetch any URL on the addon's behalf).
// Instead each playlist/segment/key reference gets replaced with a random,
// short-lived opaque token mapped server-side to the real upstream URL.
const TOKEN_TTL_MS = 5 * 60 * 1000;
const tokens = new Map(); // token -> { url, expiresAt }

function mintToken(url) {
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { url, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

function resolveToken(token) {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    tokens.delete(token);
    return null;
  }
  return entry.url;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (entry.expiresAt < now) tokens.delete(token);
  }
}, TOKEN_TTL_MS).unref();

// Xtream panels commonly gate the stream endpoints on a player-shaped
// User-Agent rather than a bare fetch/curl default.
const UPSTREAM_HEADERS = { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' };

function resolveUrl(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

function isPlaylistUrl(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

// Rewrites every URI an HLS playlist references - nested variant playlists,
// media segments, and EXT-X-KEY/EXT-X-MAP URIs - into same-origin proxy URLs
// backed by freshly minted tokens. Relative URIs are resolved against the
// playlist's own URL first (`baseUrl`), since a rewritten line no longer
// carries that context once it's replaced with an opaque token.
function rewritePlaylist(text, baseUrl, proxyOrigin) {
  const lines = text.split('\n');
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#EXT-X-KEY') || trimmed.startsWith('#EXT-X-MAP')) {
      return line.replace(/URI="([^"]+)"/, (m, uri) => {
        const token = mintToken(resolveUrl(uri, baseUrl));
        return `URI="${proxyOrigin}/proxy/seg/${token}"`;
      });
    }
    if (trimmed.startsWith('#')) return line;

    const abs = resolveUrl(trimmed, baseUrl);
    const token = mintToken(abs);
    return isPlaylistUrl(abs) ? `${proxyOrigin}/proxy/pl/${token}` : `${proxyOrigin}/proxy/seg/${token}`;
  });
  return out.join('\n');
}

module.exports = { mintToken, resolveToken, rewritePlaylist, UPSTREAM_HEADERS };
