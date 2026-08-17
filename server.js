import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';

const PORT = process.env.PORT || 3000;
const TTL = 60_000; // scrape a channel at most once per minute
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const cache = new Map(); // key -> { at, value }

async function load(url) {
	const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' } });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`upstream ${res.status}`);
	const html = await res.text();
	return Object.assign(cheerio.load(html), { html });
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
	return {
		live: Boolean(video),
		found: true,
		id: $.html.match(/"externalChannelId":"(UC[\w-]{22})"|channel\/(UC[\w-]{22})/)?.slice(1).find(Boolean) || null,
		url: video ? canonical : null,
		thumbnail: video ? `https://i.ytimg.com/vi/${video}/maxresdefault.jpg` : $('meta[property="og:image"]').attr('content') || null,
	};
}

/** Twitch: og:title ends "- Live on Twitch" only while streaming. */
async function twitch(ref) {
	const login = ref.replace(/^@/, '').toLowerCase();
	const $ = await load(`https://www.twitch.tv/${encodeURIComponent(login)}`);
	const title = $?.('meta[property="og:title"]').attr('content');
	if (!title) return { live: false, found: false };
	const live = / - Live on Twitch$/.test(title);
	return {
		live,
		found: true,
		id: login,
		url: `https://www.twitch.tv/${login}`,
		// public live preview, no key needed
		thumbnail: live ? `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-640x360.jpg` : $('meta[property="og:image"]').attr('content') || null,
	};
}

const providers = { yt, twitch };

createServer(async (req, res) => {
	const [, platform, ref] = req.url.split('?')[0].split('/');
	const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));

	if (!ref) {
		const html = await readFile(new URL('./public/index.html', import.meta.url));
		return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
	}
	if (!providers[platform]) return json(404, { error: 'unknown platform' });

	const key = `${platform}:${ref.toLowerCase()}`;
	const hit = cache.get(key);
	if (!hit || Date.now() - hit.at > TTL) {
		const value = providers[platform](decodeURIComponent(ref)).catch((err) => (cache.delete(key), Promise.reject(err)));
		cache.set(key, { at: Date.now(), value });
	}
	try {
		const entry = cache.get(key);
		json(200, { platform, ref, ...(await entry.value), age: Math.round((Date.now() - entry.at) / 1000), ttl: TTL / 1000 });
	} catch (err) {
		json(502, { error: err.message });
	}
}).listen(process.env.NODE_ENV === 'test' ? 0 : PORT, function () {
	if (process.env.NODE_ENV === 'test') this.close();
	else console.log(`amilive on :${PORT}`);
});

export { yt, twitch };
