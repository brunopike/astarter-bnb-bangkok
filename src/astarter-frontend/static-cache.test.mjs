import test from 'node:test';
import assert from 'node:assert/strict';
import {staticCacheControl,staticEtag,staticNotModified} from './static-cache.mjs';

test('pages and data stay uncached while static files can be reused',()=>{
 assert.equal(staticCacheControl('index.html'),'no-store');
 assert.equal(staticCacheControl('membership.html','/membership.html'),'no-store');
 assert.equal(staticCacheControl('api/wallet/session'),'no-store');
 assert.equal(staticCacheControl('release.json'),'no-store');
 assert.equal(staticCacheControl('brain-evidence/daily-markets.json','/brain-evidence/daily-markets.json'),'no-cache');
 assert.equal(staticCacheControl('brain-evidence/market-history.json'),'no-store');
 assert.equal(staticCacheControl('style.css','/style.css'),'no-cache');
 assert.equal(staticCacheControl('locale-messages.mjs','/locale-messages.mjs'),'no-cache');
 assert.equal(staticCacheControl('node_modules/three/build/three.module.js'),'no-cache');
 assert.equal(staticCacheControl('app.js','/app.js?v=20261126a'),'no-cache');
 assert.equal(staticCacheControl('trading-desk.js','/trading-desk.js?v=20261127nav'),'no-cache');
 assert.equal(staticCacheControl('logo.svg','/logo.svg'),'public, max-age=86400, stale-while-revalidate=604800');
 assert.equal(staticCacheControl('lite-navigation.mjs','/lite-navigation.mjs?v=74cee3eea577'),'public, max-age=31536000, immutable');
 assert.equal(staticCacheControl('fonts/inter-dbb4c50049c7.woff2'),'public, max-age=31536000, immutable');
 assert.equal(staticCacheControl('boot/part-LBMR2N3V.js'),'public, max-age=31536000, immutable');
});

test('a matching validator answers without sending the file again',()=>{
 const etag=staticEtag(878054,1_700_000_000_000.4);
 assert.equal(etag,`"${(878054).toString(16)}-${Math.floor(1_700_000_000_000.4).toString(16)}"`);
 assert.notEqual(staticEtag(878054,1_700_000_000_000),staticEtag(878055,1_700_000_000_000));
 assert.equal(staticNotModified(etag,etag),true);
 assert.equal(staticNotModified(`W/"other", ${etag}`,etag),true);
 assert.equal(staticNotModified('W/'+etag,etag),true);
 assert.equal(staticNotModified('"other"',etag),false);
 assert.equal(staticNotModified('W/"other"',etag),false);
 assert.equal(staticNotModified('',etag),false);
});
