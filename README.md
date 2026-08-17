# amilive

Is this channel streaming right now? One HTTP call, one boolean, no API keys.

YouTube and Twitch both announce live status on their public channel pages. `amilive` fetches that page, reads a single marker out of the HTML with `cheerio`, and answers true or false. No developer account, no OAuth, no login, no quota.

- YouTube: `youtube.com/@handle/live` redirects to the watch page only while streaming, so `link[rel=canonical]` pointing at `/watch?v=` means live.
- Twitch: `og:title` reads `Name - Live on Twitch` only while streaming.

## Run

```bash
npm install
npm start        # http://localhost:3000
npm test         # hits the real sites, asserts a known 24/7 stream reads live
```

Only dependency is `cheerio`. The HTTP server is `node:http`.

## Usage

Open `http://localhost:3000`, type a handle, and the page polls for you. Deep link straight to a channel with `#yt/@lofigirl` or `#twitch/lofigirl`.

## API

```
GET /yt/<handle|channelId>
GET /twitch/<login>
```

```bash
curl localhost:3000/yt/@lofigirl
curl localhost:3000/yt/UCSJ4gkVC6NrvII8umztf0Ow
curl localhost:3000/twitch/lofigirl
```

Response:

```json
{
	"platform": "yt",
	"ref": "@lofigirl",
	"live": true,
	"found": true,
	"id": "UCSJ4gkVC6NrvII8umztf0Ow",
	"url": "https://www.youtube.com/watch?v=0muHFBSiybw",
	"thumbnail": "https://i.ytimg.com/vi/0muHFBSiybw/maxresdefault.jpg",
	"age": 12,
	"ttl": 60
}
```

| field | meaning |
| --- | --- |
| `live` | streaming right now |
| `found` | channel exists and the page parsed |
| `id` | stable ref - YouTube channel id, or Twitch login |
| `url` | live watch URL when live, else `null` |
| `thumbnail` | live preview when live, else channel avatar |
| `age` | seconds since the upstream page was last scraped |
| `ttl` | seconds an answer is cached before a fresh scrape |

Errors return a JSON `error` field with the status: `400` bad ref, `404` unknown platform, `405` non-GET, `429` rate limited, `503` scrape queue saturated, `502` upstream failure.

## Freshness

An answer is at most `ttl` (60s) old. Poll as often as you like - repeat calls inside that window are served from memory and never touch YouTube or Twitch. The bundled page repolls every 20s.

## Rate limiting

Being key-free means every request is a scrape someone else pays for, so the server is deliberately stingy:

- 20 requests per minute per IP (`429` past that, with `retry-after`).
- One upstream fetch per channel per 60s, shared across all callers. Unknown channels are cached 5 minutes so junk lookups cannot amplify.
- At most 4 concurrent upstream fetches. Beyond that, cached answers still serve and cache misses get `503`.
- Handles are validated against `/^@?[A-Za-z0-9_.-]{2,60}$/`, so arbitrary URLs can never be fetched through this server.
- 500 cached channels max, 10s upstream timeout, 4MB response cap, `GET` only.

Behind a proxy, the client IP is read from `x-forwarded-for`.

## Caveat

This reads undocumented HTML. If YouTube or Twitch move their markers, detection breaks until the selector is updated. That is the tradeoff for needing no API key.
