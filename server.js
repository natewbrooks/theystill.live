import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';

const PORT = process.env.PORT || 3000;
const SITE = process.env.SITE_URL || 'https://theystill.live/'; // used by robots.txt and sitemap.xml
const TTL = 60_000; // scrape a channel at most once per minute
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// datacenter IPs get YouTube's consent interstitial, which has no canonical link. These skip it.
const YT_COOKIE = 'SOCS=CAI; CONSENT=YES+1';

const NEG_TTL = 300_000; // unknown channels stay cached longer, junk lookups cannot amplify
const RATE = { window: 60_000, max: 20 }; // per client IP
const MAX_KEYS = 500; // cache entries kept, oldest evicted first
const MAX_SCRAPES = 4; // concurrent upstream fetches
const MAX_BATCH = 10; // channels per request
const MAX_BYTES = 4 << 20; // refuse absurd upstream responses
const REF = /^@?[A-Za-z0-9_.-]{2,60}$/; // channel handles only, never arbitrary paths
const STATIC = { 'troll.svg': 'image/svg+xml', 'og.png': 'image/png', 'lexend-400.woff2': 'font/woff2', 'lexend-700.woff2': 'font/woff2' };
const BUILT = new Date().toISOString().slice(0, 10); // sitemap lastmod, stamped at boot

const cache = new Map(); // key -> { at, ttl, value }
const hits = new Map(); // ip -> { count, resetAt }
let scraping = 0;

async function load(url, extraHeaders = {}) {
	const res = await fetch(url, {
		headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...extraHeaders },
		signal: AbortSignal.timeout(10_000),
		redirect: 'follow',
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`upstream ${res.status}`);
	if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('upstream too large');
	const html = await res.text();
	if (html.length > MAX_BYTES) throw new Error('upstream too large');
	return Object.assign(cheerio.load(html), { html });
}

/**
 * Fixed-window counter per IP.
 * @returns {number} 0 when allowed, else seconds left in the window
 */
function allow(ip) {
	const now = Date.now();
	if (hits.size > 10_000) hits.clear(); // crude sweep, bounded memory
	const h = hits.get(ip);
	if (!h || now > h.resetAt) {
		hits.set(ip, { count: 1, resetAt: now + RATE.window });
		return 0;
	}
	h.count += 1;
	return h.count <= RATE.max ? 0 : Math.max(1, Math.ceil((h.resetAt - now) / 1000));
}

// "N watching now" / "Started streaming N minutes ago" only render for a currently live video
const YT_LIVE_TEXT = /" watching now"|"Started streaming /;

/** Parsed ytInitialPlayerResponse, or null when the page has none. */
function playerDetails(html) {
	const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;(?:\s*var|\s*<\/script>)/s);
	try {
		return m ? JSON.parse(m[1])?.videoDetails : null;
	} catch {
		return null;
	}
}

/**
 * Datacenter IPs get a page variant that skips the /live redirect, so the canonical trick fails there.
 * The LIVE badge still shows up, so take the candidate video ids and confirm one on its watch page.
 * Candidates can be unrelated videos from the page, so each must be live AND belong to this channel.
 * @returns {Promise<string|null>} the live video id, or null
 */
async function ytLiveFallback(html, channelId) {
	// without the channel's own id there is no way to tell its stream from a recommended one, so never guess
	if (!channelId || !/"text":"LIVE"|"style":"LIVE"/.test(html)) return null;
	const ids = [...new Set([...html.matchAll(/"videoId":"([\w-]{11})"/g)].map((m) => m[1]))].slice(0, 5);
	for (const id of ids) {
		const $ = await load(`https://www.youtube.com/watch?v=${id}`, { cookie: YT_COOKIE }).catch(() => null);
		const vd = $ && playerDetails($.html);
		if (vd?.videoId === id && vd.channelId === channelId && (vd.isLiveNow || YT_LIVE_TEXT.test($.html))) return id;
	}
	return null;
}

/**
 * YouTube: /live redirects to the watch page only while streaming.
 * @param {string} ref handle or UC... channel id
 */
async function yt(ref) {
	const path = /^UC[\w-]{22}$/.test(ref) ? `channel/${ref}` : `@${ref.replace(/^@/, '')}`;
	const $ = await load(`https://www.youtube.com/${path}/live`, { cookie: YT_COOKIE });
	if (!$) return { live: false, found: false };
	const canonical = $('link[rel="canonical"]').attr('href') || '';
	// own-channel id only: canonical/og:url name this page's channel, and a page-wide "channel/UC..."
	// match must never be used, it picks up recommended channels
	const id =
		`${canonical} ${$('meta[property="og:url"]').attr('content')}`.match(/channel\/(UC[\w-]{22})/)?.[1] ||
		$.html.match(/"externalChannelId":"(UC[\w-]{22})"|"browseId":"(UC[\w-]{22})"/)?.slice(1).find(Boolean) ||
		null;
	let video = canonical.match(/[?&]v=([\w-]{11})/)?.[1];
	// no canonical: trust the embedded player payload only when it names this channel's own live video
	if (!video) {
		const vd = playerDetails($.html);
		if (vd && (!id || vd.channelId === id) && (vd.isLiveNow || YT_LIVE_TEXT.test($.html))) video = vd.videoId;
	}
	// never report a live channel as offline just because the page was unreadable
	if (!canonical && !video) throw new Error('youtube page not readable');
	if (!video) video = await ytLiveFallback($.html, id);
	// offline falls back to the channel banner, then the avatar
	// the embedded banner URL bakes in a letterbox crop, ask for the plain 16/9 art instead
	const bannerId = $.html.match(/https:\/\/yt3\.googleusercontent\.com\/([\w-]+)=w\d+-fcrop64=/)?.[1];
	const banner = bannerId && `https://yt3.googleusercontent.com/${bannerId}=w1280`;
	const thumbnail = video ? `https://i.ytimg.com/vi/${video}/maxresdefault.jpg` : banner || $('meta[property="og:image"]').attr('content') || null;
	return {
		live: Boolean(video),
		found: true,
		id,
		url: video ? canonical || `https://www.youtube.com/watch?v=${video}` : null,
		embed: video ? `https://www.youtube.com/embed/${video}` : null,
		thumbnail,
		art: video ? 'preview' : banner ? 'banner' : 'avatar',
	};
}

/**
 * Twitch's page HTML carries no live markers (badge, viewer count, and uptime are all
 * client-rendered), so GQL's stream object is the source of truth. Its public web client id
 * needs no account, so this stays key-free.
 * @returns {Promise<{exists: boolean, live: boolean, offlineImage: string|null, avatar: string|null}|null>} null when the lookup itself failed
 */
async function twitchUser(login) {
	try {
		const res = await fetch('https://gql.twitch.tv/gql', {
			method: 'POST',
			headers: { 'client-id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'content-type': 'application/json' },
			body: JSON.stringify({ query: `{user(login:"${login}"){offlineImageURL profileImageURL(width:300) stream{id}}}` }),
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) return null;
		const user = (await res.json())?.data?.user;
		return { exists: Boolean(user), live: Boolean(user?.stream), offlineImage: user?.offlineImageURL || null, avatar: user?.profileImageURL || null };
	} catch {
		return null;
	}
}

/**
 * Preview CDN fallback: 200 only while a stream is up, 302 to a 404 placeholder otherwise.
 * Cannot prove existence or offline, only live.
 */
async function twitchPreviewLive(login) {
	const res = await fetch(`https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-640x360.jpg`, {
		method: 'HEAD',
		redirect: 'manual',
		signal: AbortSignal.timeout(5_000),
	});
	return res.status === 200;
}

/** Twitch: GQL stream presence. The page HTML has no live signal (og:title is "Name - Twitch" either way). */
async function twitch(ref) {
	const login = ref.replace(/^@/, '').toLowerCase();
	const user = await twitchUser(login);
	if (user && !user.exists) return { live: false, found: false };
	// GQL down: the preview CDN can still prove live, but never offline, so anything else throws
	// and callers see 502 while cached answers keep serving
	if (!user && !(await twitchPreviewLive(login).catch(() => false))) throw new Error('twitch gql not reachable');
	const { live = true, avatar = null, offlineImage: offline = null } = user || {};
	// public live preview, no key needed
	const thumbnail = live ? `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-640x360.jpg` : offline || avatar;
	return {
		live,
		found: true,
		id: login,
		url: `https://www.twitch.tv/${login}`,
		// Twitch requires parent to match the page hosting the iframe, so the caller fills it in
		embed: live ? `https://player.twitch.tv/?channel=${login}&parent=YOUR_DOMAIN` : null,
		thumbnail,
		art: live ? 'preview' : offline ? 'offline' : 'avatar',
	};
}

const providers = { yt, twitch };

/**
 * One channel, cached. Throws {busy:true} when the scrape queue is full and nothing is cached.
 * @returns {Promise<object>} the provider result plus how stale it is
 */
async function lookup(platform, ref) {
	const key = `${platform}:${ref.toLowerCase()}`;
	let entry = cache.get(key);
	if (!entry || Date.now() - entry.at > entry.ttl) {
		// only cached answers are served while the scrape queue is saturated
		if (scraping >= MAX_SCRAPES) {
			if (!entry) throw Object.assign(new Error('busy, retry shortly'), { busy: true });
		} else {
			scraping += 1;
			entry = { at: Date.now(), ttl: TTL };
			entry.value = providers[platform](ref)
				.then((v) => {
					entry.ttl = v.found ? TTL : NEG_TTL;
					return v;
				})
				.catch((err) => {
					cache.delete(key);
					throw err;
				})
				.finally(() => {
					scraping -= 1;
				});
			cache.set(key, entry);
			if (cache.size > MAX_KEYS) cache.delete(cache.keys().next().value);
		}
	}
	return { platform, ref, ...(await entry.value), age: Math.round((Date.now() - entry.at) / 1000), ttl: TTL / 1000 };
}

/** The page, gzipped once and kept in memory. Falls back to plain bytes for old clients. */
let page = null;
async function sendPage(req, res) {
	page ??= await readFile(new URL('./public/index.html', import.meta.url)).then((raw) => ({ raw, gz: gzipSync(raw) }));
	const gzip = (req.headers['accept-encoding'] || '').includes('gzip');
	res.writeHead(200, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'public, max-age=300',
		// /yt/ref serves HTML or JSON off the same URL, so caches must key on both headers
		vary: 'accept, accept-encoding',
		...(gzip ? { 'content-encoding': 'gzip' } : {}),
	}).end(gzip ? page.gz : page.raw);
}

const server = createServer(async (req, res) => {
	// read-only public API, so any origin may call it
	const json = (code, body, headers) =>
		res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', vary: 'accept', ...headers }).end(JSON.stringify(body));
	if (req.method !== 'GET') return json(405, { error: 'GET only' });
	if (req.url.length > 200) return json(414, { error: 'url too long' });

	const [, platform, rawRef] = req.url.split('?')[0].split('/');

	if (!platform && !rawRef) return sendPage(req, res);
	if (STATIC[platform] && !rawRef) {
		const file = await readFile(new URL(`./public/${platform}`, import.meta.url));
		return res.writeHead(200, { 'content-type': STATIC[platform], 'cache-control': 'public, max-age=604800' }).end(file);
	}
	// per-channel paths are thin duplicates of the home page, so they stay out of the index
	if (platform === 'robots.txt')
		return res
			.writeHead(200, { 'content-type': 'text/plain' })
			.end(`User-agent: *\nAllow: /$\nAllow: /og.png\nDisallow: /yt/\nDisallow: /twitch/\n\nSitemap: ${SITE}sitemap.xml\n`);
	if (platform === 'sitemap.xml') {
		const body =
			`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
			`<url><loc>${SITE}</loc><lastmod>${BUILT}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url></urlset>\n`;
		return res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
	}
	if (!providers[platform]) return json(404, { error: 'unknown platform' });
	// browsers asking for /yt/handle get the page, API clients get JSON
	if ((req.headers.accept || '').includes('text/html')) return sendPage(req, res);

	// comma-separated for batches, each entry optionally "platform:ref" to mix platforms
	let refs;
	try {
		refs = decodeURIComponent(rawRef).split(',').filter(Boolean);
	} catch {
		return json(400, { error: 'bad ref' });
	}
	if (!refs.length || refs.length > MAX_BATCH) return json(400, { error: `1 to ${MAX_BATCH} channels per request` });

	const targets = refs.map((entry) => {
		const [maybePlatform, ...rest] = entry.split(':');
		return rest.length && providers[maybePlatform] ? { platform: maybePlatform, ref: rest.join(':') } : { platform, ref: entry };
	});
	if (targets.some((t) => !REF.test(t.ref))) return json(400, { error: 'bad ref' });

	const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
	// a batch spends one unit of budget per channel
	let cooldown = 0;
	for (const _ of targets) cooldown = allow(ip) || cooldown;
	if (cooldown) return json(429, { error: `rate limited, try again in ${cooldown}s`, retryAfter: cooldown }, { 'retry-after': cooldown });

	const results = await Promise.all(
		targets.map((t) =>
			lookup(t.platform, t.ref).catch((err) => ({ platform: t.platform, ref: t.ref, error: err.message, busy: Boolean(err.busy) || undefined })),
		),
	);
	if (results.length === 1) {
		const only = results[0];
		if (only.error) return json(only.busy ? 503 : 502, { error: only.error }, only.busy ? { 'retry-after': 5 } : undefined);
		return json(200, only);
	}
	json(200, { results, live: results.filter((r) => r.live).map((r) => `${r.platform}:${r.ref}`) });
});

if (process.env.NODE_ENV !== 'test') server.listen(PORT, () => console.log(`theystill.live on :${PORT}`));

export { yt, twitch, server, RATE };
