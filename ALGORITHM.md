# Live detection algorithm

How `server.js` decides `live: true` without API keys. Each platform runs a chain of signals, strongest first. A weaker signal only runs when the stronger one is unavailable, never to overrule it.

## YouTube (`yt()`)

Fetch `youtube.com/@handle/live` (or `/channel/UC.../live`) with a browser user agent and consent cookies (`SOCS=CAI; CONSENT=YES+1`) so datacenter IPs skip the consent interstitial.

1. **Canonical redirect.** While streaming, `/live` serves a watch page whose `link[rel=canonical]` points at `/watch?v=<id>`. Offline, canonical points back at the channel. This is the primary signal. The datacenter variant serves `href="undefined"` (literally), which never matches and pushes into the fallbacks.
2. **Embedded player payload.** Some page variants keep the channel URL and no watch canonical. Parse `ytInitialPlayerResponse` and accept its `videoDetails` only when `isLiveNow` is true and `channelId` matches the channel being asked about.
3. **Unreadable page guard.** No canonical and no verified video means the page shape is unknown. Throw instead of answering, so a live channel is never reported offline off a broken scrape.
4. **Candidate sweep (`ytLiveFallback`).** If the page shows a `LIVE` badge (`"text":"LIVE"` / `"style":"LIVE"`) or live-only text (`" watching now"` / `"Started streaming ..."`) but no verified video, take up to 5 distinct `videoId`s from the page and confirm each over the key-free innertube endpoint (`POST youtubei/v1/player`). Accept the first whose `videoDetails` has `isLive` and this channel's `channelId`. Watch pages cannot be used here: YouTube answers them with `429` from datacenter IPs, while the innertube JSON endpoint responds.

The channel ownership check in steps 2 and 4 exists because a channel page embeds `videoId`s of unrelated videos. Without it, a recommended stream from a different channel can be reported as this channel's stream. The channel's own id comes only from sources that name the page itself, in order: a `channel/UC...` canonical or `og:url`, then `externalChannelId`, then `browseId`. A page-wide `channel/UC...` match is never used, it picks up recommended channels. When no own id can be extracted, the candidate sweep refuses to guess.

Channel existence: a 404 from YouTube means `found: false`.

## Twitch (`twitch()`)

Twitch's page HTML carries no live markers. The LIVE badge, viewer count, and uptime are all client-rendered from GraphQL data, so the server asks the same source.

1. **GQL stream object.** POST to `gql.twitch.tv/gql` with Twitch's public web `client-id` (key-free), querying `user(login){stream{id} offlineImageURL profileImageURL}`. A non-null `stream` means live. A null `user` means the login does not exist (`found: false`). This is the same data behind the client-rendered LIVE badge, viewer count, and uptime elements, which never appear in the page HTML and so cannot be scraped.
2. **Preview CDN fallback.** Only when GQL is unreachable: `HEAD static-cdn.jtvnw.net/previews-ttv/live_user_<login>-640x360.jpg`. It answers `200` only while a stream is up and `302` to a 404 placeholder otherwise. The placeholder is identical for offline and nonexistent logins, so this can prove live but never offline.
3. **No offline guess.** `og:title` reads `Name - Twitch` whether live or not (the old `" - Live on Twitch"` suffix is gone), so when GQL is down and the preview is not live, the lookup throws instead of guessing. Callers get `502` and cached answers keep serving.

## Shared behavior

- Answers cache for 60s per channel (`TTL`), unknown channels for 5 minutes (`NEG_TTL`).
- Scrape failures propagate as errors rather than a false `live: false`. Callers see `502`, cached answers keep serving.
- Thumbnail choice: live preview when live, else offline art, then banner, then avatar. The `art` field names which one was used.
