import express from 'express';
import * as cheerio from 'cheerio';

const PORT = process.env.PORT || 3000;
const TTL = 60_000; // upstream scrape at most once per minute per channel
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** channel key -> { at, value } */
const cache = new Map();

/** Scrape at most once per TTL per key, share in-flight promise. */
function cached(key, fn) {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < TTL) return hit.value;
	const value = fn().catch((err) => {
		cache.delete(key);
		throw err;
	});
	cache.set(key, { at: Date.now(), value });
	return value;
}

async function load(url) {
	const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' } });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`upstream ${res.status}`);
	const html = await res.text();
	return Object.assign(cheerio.load(html), { html });
}

/**
 * YouTube: /live redirects to the live watch page when live.
 * @param {string} ref handle (with or without @) or UC... channel id
 */
async function youtube(ref) {
	const path = /^UC[\w-]{22}$/.test(ref) ? `channel/${ref}` : `@${ref.replace(/^@/, '')}`;
	const $ = await load(`https://www.youtube.com/${path}/live`);
	if (!$) return { live: false, found: false };
	const canonical = $('link[rel="canonical"]').attr('href') || '';
	const channelId = $.html.match(/"externalChannelId":"(UC[\w-]{22})"|channel\/(UC[\w-]{22})/)?.slice(1).find(Boolean) || null;
	const videoId = canonical.match(/[?&]v=([\w-]{11})/)?.[1] || null;
	return {
		live: Boolean(videoId),
		found: true,
		id: channelId,
		url: videoId ? canonical : null,
		thumb: videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : $('meta[property="og:image"]').attr('content') || null,
	};
}

/**
 * Twitch: og:title reads "name - Live on Twitch" only while streaming.
 * @param {string} ref login name
 */
async function twitch(ref) {
	const login = ref.replace(/^@/, '').toLowerCase();
	const $ = await load(`https://www.twitch.tv/${encodeURIComponent(login)}`);
	if (!$) return { live: false, found: false };
	const title = $('meta[property="og:title"]').attr('content') || '';
	if (!title) return { live: false, found: false };
	const live = / - Live on Twitch$/.test(title);
	return {
		live,
		found: true,
		id: login,
		url: `https://www.twitch.tv/${login}`,
		// live preview is public, no key needed; falls back to profile image when offline
		thumb: live
			? `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-640x360.jpg`
			: $('meta[property="og:image"]').attr('content') || null,
	};
}

const providers = { yt: youtube, twitch };

const app = express();
app.use(express.static('public'));

app.get('/:platform/:ref', async (req, res) => {
	const { platform, ref } = req.params;
	const provider = providers[platform];
	if (!provider) return res.status(404).json({ error: 'unknown platform' });
	try {
		const data = await cached(`${platform}:${ref.toLowerCase()}`, () => provider(ref));
		res.set('cache-control', 'public, max-age=30').json({ platform, ref, ...data, ttl: TTL / 1000 });
	} catch (err) {
		res.status(502).json({ error: String(err.message) });
	}
});

if (process.env.NODE_ENV !== 'test') app.listen(PORT, () => console.log(`amilive on :${PORT}`));

export { youtube, twitch };
