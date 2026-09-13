// Thin client for the Xtream Codes "player_api.php" JSON API + xmltv.php EPG feed.
class XtreamClient {
  constructor({ server, username, password }) {
    let base = server.trim();
    if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
    this.base = base.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
  }

  get key() {
    return `${this.base}|${this.username}|${this.password}`;
  }

  apiUrl(action, extraParams = {}) {
    const url = new URL(`${this.base}/player_api.php`);
    url.searchParams.set('username', this.username);
    url.searchParams.set('password', this.password);
    if (action) url.searchParams.set('action', action);
    for (const [k, v] of Object.entries(extraParams)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    return url.toString();
  }

  async fetchJson(url, timeoutMs = 25000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Xtream request failed: HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async getAccountInfo() {
    return this.fetchJson(this.apiUrl(''));
  }

  async getLiveCategories() {
    const data = await this.fetchJson(this.apiUrl('get_live_categories'));
    return Array.isArray(data) ? data : [];
  }

  async getAllLiveStreams() {
    const data = await this.fetchJson(this.apiUrl('get_live_streams'), 60000);
    return Array.isArray(data) ? data : [];
  }

  xmltvUrl() {
    const url = new URL(`${this.base}/xmltv.php`);
    url.searchParams.set('username', this.username);
    url.searchParams.set('password', this.password);
    return url.toString();
  }

  buildStreamUrl(streamId, ext = 'm3u8') {
    return `${this.base}/live/${this.username}/${this.password}/${streamId}.${ext}`;
  }
}

module.exports = { XtreamClient };
