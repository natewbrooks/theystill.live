import assert from 'node:assert';
import { youtube, twitch } from './server.js';

/** Hits the real sites: known 24/7 stream is live, bogus handle is not found. */
const yt = await youtube('@lofigirl');
assert.equal(yt.live, true, 'lofigirl youtube should be live');
assert.match(yt.id, /^UC[\w-]{22}$/);

const tw = await twitch('lofigirl');
assert.equal(tw.found, true);

const missing = await youtube('@definitely-not-a-real-channel-zzz9');
assert.equal(missing.live, false);

console.log('ok');
