# My IPTV Sports (Stremio addon)

Turns your personal Xtream Codes IPTV account into a Stremio catalog of live
sports events, matched and deduplicated from your live channel list + EPG.
Same shape as [sportsfree-us2.highfly.dev](https://sportsfree-us2.highfly.dev/configure)
(sport filters, live-only toggle, timezone, hide titles/descriptions) but
sourced from your own panel instead of a third-party feed.

## How the matching works

1. Pulls every live channel and category from your panel, and classifies
   categories into a sport - American Football (NFL) and NCAAF (college
   football) are separate categories, and NBA and NCAAB (college basketball)
   are separate categories, plus Football (soccer), Hockey, Baseball, Motor
   Sports, Fight, Tennis, Rugby, Golf, Billiards, AFL, Darts, Cricket, and
   Other - by keyword.
2. For each channel in a sport category, tries to parse a "Team A vs Team B"
   matchup straight out of the channel name (providers format these very
   inconsistently - `NFL | 03 - 1pm Buccaneers at Bengals`,
   `DAZN FR 042| Genoa vs. Frosinone | Serie A (2026-09-12 15:00:00)`, etc).
3. If the name is just a placeholder (`NBA EVENT`, `MA | No Event`, ...) but
   the channel has an EPG id, it falls back to that channel's current XMLTV
   programme title instead (`San Francisco 49ers vs. Los Angeles Rams`). This
   EPG lookup is purely a backend aid for *finding* matchup text on channels
   whose own name is just a brand ("beIN Sports 1") - it never feeds the
   displayed schedule/live status, and nothing EPG-derived is shown as-is.
4. Matchups are cleaned of broadcaster/date/league noise, then grouped: the
   same real game is almost always listed on many channels (different
   languages, qualities, backup feeds, sometimes with home/away reversed)
   - these get merged into one catalog entry with every underlying stream as
   a selectable source, using fuzzy (Levenshtein) name matching that's aware
   of which side is which even when a source lists the teams in swapped order.
5. Anything sport-category but not matchup-shaped (a linear network like
   ESPN or beIN Sport) still shows up, just as a plain channel instead of an
   event card.
6. Every matchup is then checked against [ESPN's public scoreboard API](https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard)
   (the same one [ha-teamtracker](https://github.com/vasqued2/ha-teamtracker)
   for Home Assistant is built on - no key/auth needed) for NFL, NCAAF (full
   FBS slate, not just ranked teams), NBA, NCAAB (men's, both tours), Premier
   League, LaLiga, Bundesliga, Serie A, Ligue 1, Champions League, Europa
   League, MLS, WNBA, NHL, MLB, UFC, AFL, and ATP/WTA tennis (tennis "events"
   are whole tournaments with hundreds of individual matches nested
   underneath, unlike the flat one-game-per-event shape everything else uses
   - handled as its own case). NFL, NCAAF, NBA and NCAAB are queried and
   sorted first since they're prioritized. A fuzzy team-name match there
   overrides the guessed sport/league with ESPN's real classification and
   supplies the kickoff time and live/upcoming/final state. The match is
   restricted to the same sport once one is known, both to keep 1000+ tennis
   matches from slowing down every other sport's lookup and to stop a team
   name from ever matching against an unrelated player by coincidence.

**ESPN is the only source of live/upcoming/ended state, full stop** - the
catalog only shows matchups ESPN confirms are live right now or starting
within the **Upcoming Window** you set in `/configure` (30 minutes to 24
hours, 3 hours by default). A channel-name (or EPG-title) match that ESPN
doesn't recognize (an untracked league, a bad parse) isn't guessed at - it's
just not shown. The optional "Live matches only" toggle narrows this further
to hide the upcoming-soon ones too. Kickoff times are shown in the named
**Timezone** you pick there too (e.g. "Eastern Time (New York)") - it's
formatted live against that IANA zone rather than a fixed UTC offset baked in
at config time, so the displayed time (and its EST/EDT-style abbreviation)
stays correct across a DST transition instead of drifting an hour twice a year.

7. Two more sources feed the same "which of my channels also carries this
   game" matching:
   - **Free, no extra request**: ESPN's own scoreboard response already
     names the real broadcaster for most US games ("NBC", "FOX", "Peacock",
     "BTN", "MLB.TV", regional feeds like "YES"/"Marquee Sports Net") - data
     already being fetched for live status, so this runs for every visible
     event with no cap and no rate limit to worry about.
   - **[TheSportsDB](https://www.thesportsdb.com/docs_api_guide#search_v1)**
     fills in the international broadcasters ESPN's US-centric data doesn't
     cover (its `lookuptv.php` endpoint - "DAZN 1", "Sky Sports Football",
     "Movistar Liga de Campeones"), rate-limited so it only runs for a
     handful of events per rebuild (see Notes below).

   Both match their broadcaster names against your own plain channel list
   (the linear networks that never had a matchup in their name, like
   "beIN Sports 1") to attach any of *those* as extra sources too - catching
   channels the name/EPG-based matching above never had a reason to associate
   with this specific game. Neither ever sets timing or status - same
   division of labor as the EPG. To keep false attachments out, a broadcaster
   name only counts as the same channel when it's an exact match or one is
   the other plus a trailing qualifier (country/quality/language) - a generic
   channel name like "Sports 2" won't spuriously match just because a
   differently-named broadcaster happens to contain those words.

8. "Slot" channels are a broader version of the same idea: a local affiliate
   named by market/callsign ("ABC 7 (WXYZ) Detroit"), a team-specific feed
   ("NFL TEAMS: CBS Patriots (WBZ) Boston MA"), or a numbered placeholder
   ("NFL Game Pass 5 :", "NCAAF 37") all show a *different* specific game
   depending on what's scheduled, with no matchup anywhere in the channel's
   own name. Every channel that doesn't parse to a matchup gets one more
   pass before landing in the plain channel list: does its own name mention
   one of a scheduled-ahead game's teams directly ("Patriots" in the example
   above), or does its EPG entry's generic sport label + venue in the
   description ("College Football" / "From Kyle Field...") match ESPN's
   per-game venue? Either one attaches it as a source on that event instead
   of listing it standalone - matched against *any* game ESPN has confirmed
   live or upcoming, not just ones inside your configured Upcoming Window
   (that result is shared across every install of the same Xtream account,
   each with its own window, so a "NFL | Bills" channel attaches to the
   Bills' next game as soon as it's on the schedule, days out if need be -
   the window only decides when the *event card* enters your catalog, not
   whether this channel counts as one of its sources).

   Whatever's left unmatched is then judged on whether it names a specific
   team at all. For NFL/NCAAF/NBA/NCAAB, every channel is checked against
   that league's full ESPN roster (recognizing the team by its nickname -
   "Seahawks" for Seattle - and bridging a handful of known rebrands like
   Washington's old "Redskins" name some panels still use): a channel
   naming a real team that has no live/upcoming game right now is hidden
   outright rather than left sitting in the list as a dead entry - it'll
   reappear as a source once that team is actually playing. A channel that
   doesn't name any specific team (a real network like "beIN Sports 1", or
   a generic always-on feed like "NFL Network"/"Sky Sports NFL"/"NFL
   Redzone") isn't "playing" or not in the same sense, so it stays
   browsable regardless. Anything left after that which reads as pure
   placeholder noise ("No Event", "No Scheduled Event", a bare "NCAAB 14",
   "TENNIS TV - EVENT 3") is dropped too.

9. Once a group has more than one source, they're sorted best quality first
   in the Stremio source picker (`[4K]`/`[FHD]`/`[HD]`/`[SD]` tags shown on
   the title) - detected from each channel's raw, unstripped name, including
   the stylized unicode quality markers (ᵁᴴᴰ, ᴴᴰ) some panels use instead of
   plain ASCII. A source with no detectable quality tag sorts after the ones
   that have one, rather than displacing them.

This is text-based heuristic matching for *finding and grouping* matchups,
backed by a real schedule for deciding *whether to show them* - not a
guarantee. Two spellings of the same club with no shared substring (e.g.
"Bilbao" vs "Athletic Club" for Athletic Bilbao) can still end up as separate
entries, since there's no team-alias database backing the fuzzy match. The
flip side is guarded deliberately: the fuzzy match refuses to merge two
names just because one contains the other when the extra text looks like a
real disambiguator ("Texas" vs "Texas A&M", "Arizona" vs "Arizona State",
"Miami" vs "Miami (OH)" all stay separate) - college sports in particular is
full of real rival schools whose names differ by exactly one qualifier word,
and merging two different real games into one catalog entry is a far worse
mistake than leaving a duplicate name unmerged.

## Catalogs, posters, and favorite teams

Each sport gets its own catalog in Stremio (an "NFL" row, an "NCAAF" row,
...) rather than one shared "Sports Events"/"Sports Channels" catalog
filtered by a genre dropdown - picking a sport is just picking which catalog
to browse, matching sports up with real Stremio content types. Events and
that sport's plain channels are combined into one list per catalog.

Event posters show the two teams' real ESPN logos side by side (or a
sport-colored "Team A vs Team B" text card when a logo isn't available for
one or both sides), generated on the fly as SVG. The logos are fetched once
and embedded directly into the SVG as base64 data - a browser loading an SVG
as an `<img>` (which is exactly what Stremio's poster/background tags are)
refuses to load any *external* resource referenced from inside it, so a
plain `<image href="https://...">` would just render blank; embedding the
bytes sidesteps that restriction entirely.

For NFL, NCAAF, NBA and NCAAB, `/configure` has a **Favorite Teams** picker
(searchable, since NCAAF/NCAAB run into the hundreds of schools) - pick your
teams there and that league's Stremio catalog gains a "Favorites" genre
option, filtering the row down to just games involving one of your teams. A
league with no favorites picked skips the option entirely rather than
offering a filter that would always return nothing.

## Setup

```bash
npm install
npm start
```

Then open **http://127.0.0.1:7788/configure**, enter your Xtream server URL,
username and password, set your preferences, and click **Generate install
link** → **Install in Stremio**.

Nothing is stored server-side - all settings (including your Xtream login)
are encoded into the addon's own install URL, exactly like the reference
addon does.

## Deploying with Docker / Coolify

A `Dockerfile` and `docker-compose.yml` are included, so this runs the same
way anywhere Docker does:

```bash
docker build -t xtream-sports-stremio .
docker run -p 7788:7788 xtream-sports-stremio
```

or with Compose:

```bash
docker compose up -d
```

**On [Coolify](https://coolify.io):** create a new resource → "Public
Repository" (or your own Git source) → point it at this repo → Coolify
detects the `Dockerfile` (or the compose file, if you pick the Docker
Compose build pack) automatically. Set the exposed port to **7788**, and
optionally add a `THESPORTSDB_API_KEY` environment variable if you have your
own key. Once deployed, open `https://your-coolify-domain/configure` in
place of `http://127.0.0.1:7788/configure` and generate your install link
from there - everything else (Xtream login, sports, favorites, etc.) works
identically, since config is still encoded client-side into the install URL
and nothing is persisted server-side.

## Notes

- The full EPG (`xmltv.php`) can be tens of MB on a large panel; it's fetched
  once and cached for 3 hours. The ESPN schedule is cached for 3 minutes.
  The event catalog itself is rebuilt from cached data every 3 minutes so
  live/upcoming/ended transitions show up promptly.
- TheSportsDB enrichment uses their public test key (`123`) by default, which
  is shared across everyone testing against it and rate-limits hard. Requests
  are throttled and capped to ~12 events per catalog rebuild (NFL/NCAAF
  first) to stay under that, so full coverage fills in gradually over a few
  rebuilds as results get cached (1 hour). For reliable, faster coverage, get
  your own key from [thesportsdb.com](https://www.thesportsdb.com/) (their
  Patreon tiers) and run with `THESPORTSDB_API_KEY=yourkey npm start`.
- First catalog load after starting the server can take several seconds on a
  big panel (tens of thousands of channels) while the EPG downloads.
- Streams are returned as direct `http://server/live/user/pass/id.m3u8` URLs
  from your own panel - playback quality/limits are whatever your Xtream
  plan allows (check `max_connections` on your account if playback fails
  when a second stream is opened).
