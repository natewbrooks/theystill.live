import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';

const PORT = process.env.PORT || 3000;
const SITE = process.env.SITE_URL || 'https://amilive.up.railway.app/'; // used by robots.txt and sitemap.xml
const TTL = 60_000; // scrape a channel at most once per minute
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const NEG_TTL = 300_000; // unknown channels stay cached longer, junk lookups cannot amplify
const RATE = { window: 60_000, max: 20 }; // per client IP
const MAX_KEYS = 500; // cache entries kept, oldest evicted first
const MAX_SCRAPES = 4; // concurrent upstream fetches
const MAX_BYTES = 4 << 20; // refuse absurd upstream responses
const REF = /^@?[A-Za-z0-9_.-]{2,60}$/; // channel handles only, never arbitrary paths

const cache = new Map(); // key -> { at, ttl, value }
const hits = new Map(); // ip -> { count, resetAt }
let scraping = 0;

async function load(url) {
	const res = await fetch(url, {
		headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
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

/**
 * YouTube: /live redirects to the watch page only while streaming.
 * @param {string} ref handle or UC... channel id
 */
async function yt(ref) {
	const path = /^UC[\w-]{22}$/.test(ref) ? `channel/${ref}` : `@${ref.replace(/^@/, '')}`;
	const $ = await load(`https://www.youtube.com/${path}/live`);
	if (!$) return { live: false, found: false };
	const canonical = $('link[rel="canonical"]').attr('href') || '';
	const video = canonical.match(/[?&]v=([\w-]{11})/)?.[1];
	// offline falls back to the channel banner, then the avatar
	const banner = $.html.match(/https:\/\/yt3\.googleusercontent\.com\/[\w-]+=w1707-fcrop64=[^"\\]+/)?.[0];
	const thumbnail = video ? `https://i.ytimg.com/vi/${video}/maxresdefault.jpg` : banner || $('meta[property="og:image"]').attr('content') || null;
	return {
		live: Boolean(video),
		found: true,
		id: $.html.match(/"externalChannelId":"(UC[\w-]{22})"|channel\/(UC[\w-]{22})/)?.slice(1).find(Boolean) || null,
		url: video ? canonical : null,
		thumbnail,
		art: video ? 'preview' : banner ? 'banner' : 'avatar',
	};
}

/**
 * Twitch's offline art and channel existence are not in the page HTML. Its public web client id
 * needs no account, so this stays key-free.
 * @returns {Promise<{exists: boolean, offlineImage: string|null}|null>} null when the lookup itself failed
 */
async function twitchUser(login) {
	try {
		const res = await fetch('https://gql.twitch.tv/gql', {
			method: 'POST',
			headers: { 'client-id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'content-type': 'application/json' },
			body: JSON.stringify({ query: `{user(login:"${login}"){offlineImageURL}}` }),
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) return null;
		const user = (await res.json())?.data?.user;
		return { exists: Boolean(user), offlineImage: user?.offlineImageURL || null };
	} catch {
		return null;
	}
}

/** Twitch: og:title ends "- Live on Twitch" only while streaming. */
async function twitch(ref) {
	const login = ref.replace(/^@/, '').toLowerCase();
	const $ = await load(`https://www.twitch.tv/${encodeURIComponent(login)}`);
	const title = $?.('meta[property="og:title"]').attr('content');
	if (!title) return { live: false, found: false };
	const live = / - Live on Twitch$/.test(title);
	const avatar = $('meta[property="og:image"]').attr('content') || null;
	// deleted, banned, or never existed: Twitch still serves a page, with its generic logo
	let offline = null;
	if (!live) {
		const user = await twitchUser(login);
		if (user ? !user.exists : avatar?.includes('ttv-static-metadata')) return { live: false, found: false };
		offline = user?.offlineImage || null;
	}
	// public live preview, no key needed
	const thumbnail = live ? `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-640x360.jpg` : offline || avatar;
	return {
		live,
		found: true,
		id: login,
		url: `https://www.twitch.tv/${login}`,
		thumbnail,
		art: live ? 'preview' : offline ? 'offline' : 'avatar',
	};
}

const providers = { yt, twitch };

const server = createServer(async (req, res) => {
	const json = (code, body, headers) => res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
	if (req.method !== 'GET') return json(405, { error: 'GET only' });
	if (req.url.length > 200) return json(414, { error: 'url too long' });

	const [, platform, rawRef] = req.url.split('?')[0].split('/');

	if (!platform && !rawRef) {
		const html = await readFile(new URL('./public/index.html', import.meta.url));
		return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
	}
	if (platform === 'robots.txt') return res.writeHead(200, { 'content-type': 'text/plain' }).end(`User-agent: *\nAllow: /$\nDisallow: /yt/\nDisallow: /twitch/\nSitemap: ${SITE}sitemap.xml\n`);
	if (platform === 'sitemap.xml') {
		const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}</loc><changefreq>weekly</changefreq></url></urlset>\n`;
		return res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
	}
	if (!providers[platform]) return json(404, { error: 'unknown platform' });
	// browsers asking for /yt/handle get the page, API clients get JSON
	if ((req.headers.accept || '').includes('text/html')) {
		const html = await readFile(new URL('./public/index.html', import.meta.url));
		return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
	}

	let ref;
	try {
		ref = decodeURIComponent(rawRef);
	} catch {
		return json(400, { error: 'bad ref' });
	}
	if (!REF.test(ref)) return json(400, { error: 'bad ref' });

	const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
	const cooldown = allow(ip);
	if (cooldown) return json(429, { error: `rate limited, try again in ${cooldown}s`, retryAfter: cooldown }, { 'retry-after': cooldown });

	const key = `${platform}:${ref.toLowerCase()}`;
	let entry = cache.get(key);
	if (!entry || Date.now() - entry.at > entry.ttl) {
		// only cached answers are served while the scrape queue is saturated
		if (scraping >= MAX_SCRAPES) {
			if (!entry) return json(503, { error: 'busy, retry shortly' }, { 'retry-after': 5 });
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
	try {
		json(200, { platform, ref, ...(await entry.value), age: Math.round((Date.now() - entry.at) / 1000), ttl: TTL / 1000 });
	} catch (err) {
		json(502, { error: err.message });
	}
});

if (process.env.NODE_ENV !== 'test') server.listen(PORT, () => console.log(`amilive on :${PORT}`));

export { yt, twitch, server, RATE };
