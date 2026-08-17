import assert from 'node:assert';
import { yt as youtube, twitch, server, RATE } from './server.js';

/** Scrapers: hits the real sites, a known 24/7 stream must read live. */
const yt = await youtube('@lofigirl');
assert.equal(yt.live, true, 'lofigirl youtube should be live');
assert.match(yt.id, /^UC[\w-]{22}$/);
assert.ok(yt.thumbnail, 'live result carries a thumbnail');
assert.match(yt.embed, /^https:\/\/www\.youtube\.com\/embed\/[\w-]{11}$/, 'live result carries an embed url');

const twLive = await twitch('lofigirl');
if (twLive.live) assert.match(twLive.embed, /player\.twitch\.tv\/\?channel=lofigirl&parent=YOUR_DOMAIN/);

const tw = await twitch('lofigirl');
assert.equal(tw.found, true);

const missing = await youtube('@definitely-not-a-real-channel-zzz9');
assert.equal(missing.live, false);

/** Request guards, over a real socket. */
server.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (path, init) => fetch(base + path, init);

assert.equal((await get('/')).status, 200, 'root serves the page');
assert.equal((await get('/yt/@a', { method: 'POST' })).status, 405, 'non-GET rejected');
assert.equal((await get('/nope/x')).status, 404, 'unknown platform rejected');
assert.equal((await get('/etc/passwd')).status, 404, 'stray path is not a platform');
assert.equal((await get(`/yt/${'a'.repeat(250)}`)).status, 414, 'long url rejected');
assert.equal((await get('/yt/a')).status, 400, 'ref under 2 chars rejected');
assert.equal((await get('/yt/' + encodeURIComponent('https://evil.test/x'))).status, 400, 'url as ref rejected');
assert.equal((await get('/yt/' + encodeURIComponent('bad ref!'))).status, 400, 'illegal chars rejected');
assert.equal((await get('/yt/%E0%A4%A')).status, 400, 'undecodable ref rejected');

/** Batch: comma-separated refs, and "platform:ref" entries mix platforms in one call. */
const batch = await (await get('/twitch/lofigirl,ludwig')).json();
assert.equal(batch.results.length, 2);
assert.ok(batch.results.every((r) => r.platform === 'twitch'));
assert.deepEqual(
	batch.live,
	batch.results.filter((r) => r.live).map((r) => `${r.platform}:${r.ref}`),
);

const mixed = await (await get('/yt/@lofigirl,twitch:ludwig')).json();
assert.deepEqual(
	mixed.results.map((r) => r.platform),
	['yt', 'twitch'],
);
assert.equal((await get('/yt/' + Array.from({ length: 11 }, (_, i) => `chan${i}`).join(','))).status, 400, 'batch cap enforced');
assert.equal((await get('/yt/@lofigirl,bad ref!')).status, 400, 'one bad ref rejects the batch');

/** Cache: the second hit is served from memory, so age only grows. */
const first = await (await get('/twitch/lofigirl')).json();
const second = await (await get('/twitch/lofigirl')).json();
assert.equal(second.ttl, 60);
assert.ok(second.age >= first.age, 'repeat call reuses the cached scrape');

/** Rate limit: runs last, it burns this IP's whole window. */
let limited = 0;
for (let i = 0; i < RATE.max + 5; i++) {
	const res = await get('/twitch/lofigirl');
	if (res.status === 429) {
		limited += 1;
		const body = await res.json();
		assert.ok(Number(res.headers.get('retry-after')) > 0, '429 carries retry-after');
		assert.ok(body.retryAfter > 0 && body.retryAfter <= RATE.window / 1000, 'cooldown is within the window');
		assert.match(body.error, /try again in \d+s/, '429 names the cooldown');
		continue;
	}
	await res.arrayBuffer();
}
assert.ok(limited >= 5, `expected requests past ${RATE.max}/min to be limited, got ${limited}`);

server.close();
console.log('ok');
