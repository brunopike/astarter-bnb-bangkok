#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const origin = 'https://demo.astarter.io';
const config = { schemaVersion: 1, siteOrigin: origin, chainId: 56, walletProvider: 'binance-agentic-wallet' };
const proofPath = '/api/brain/proof';
const toolName = 'get_deep_brain_brief';
const version = 'brain-agent-brief-v1';
const help = [
  'Astarter read-only CLI · Node.js 20+',
  'Usage: node astarter.mjs [--config FILE] COMMAND [ARG]',
  '',
  '  doctor, status          Check the official Deep Brain tool endpoint',
  '  markets [SYMBOL]        Read timestamped Atlas Oracle quotes, e.g. markets BTC',
  '  research                List the assets available for Deep Brain research',
  '  research ASSET_KEY      Read a decision brief, e.g. research coin:bitcoin',
  '  connect                 Show the wallet setup link and next step',
  '  help                    Show this help',
  '',
  'Results are JSON. Browser sessions, signing and trading stay outside this CLI.'
].join('\n');

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

async function readConfig(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8192) fail('INVALID_CONFIG', 'Choose the public configuration JSON downloaded from Astarter settings.');
    const parsed = JSON.parse(await handle.readFile('utf8'));
    if (!parsed || Object.keys(parsed).length !== Object.keys(config).length ||
        !Object.entries(config).every(([key, value]) => Object.hasOwn(parsed, key) && parsed[key] === value)) {
      fail('INVALID_CONFIG', 'Only the four official public configuration fields are accepted.');
    }
  } catch {
    fail('INVALID_CONFIG', 'Could not read a valid public Astarter configuration. Download it from the official settings page.');
  } finally {
    await handle?.close();
  }
}

const assetKey = value => typeof value === 'string' && value.length <= 128 && /^[a-z][a-z0-9-]*:[a-zA-Z0-9._-]+$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const symbolPattern = /^[A-Z0-9][A-Z0-9._-]{0,23}$/;
const malformed = () => fail('INVALID_RESPONSE', 'The official endpoint returned an unexpected data format.');

export async function run(argv, { fetchImpl = fetch, now = Date.now } = {}) {
  const args = [];
  let file;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--config') { args.push(argv[i]); continue; }
    if (file || !argv[i + 1] || argv[i + 1].startsWith('-')) fail('USAGE', 'Supply one file after --config.');
    file = argv[++i];
  }
  const [command = 'help', arg] = args;
  if (args.length > 2 || !['markets', 'research'].includes(command) && arg !== undefined) fail('USAGE', 'See node astarter.mjs help for valid arguments.');
  if (file) await readConfig(file);
  if (['help', '-h', '--help'].includes(command)) return help;
  if (command === 'connect') return {
    siteOrigin: origin, chainId: config.chainId, walletProvider: config.walletProvider,
    url: origin + '/settings#ux-local-agent',
    nextStep: 'Open the URL in your browser and follow the Binance Agentic Wallet setup. Complete address verification in the browser.'
  };

  async function get(path) {
    const url = origin + path;
    const signal = AbortSignal.timeout(12_000);
    try {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { Accept: 'application/json' }, signal });
      if (response.status !== 200) fail('HTTP_ERROR', 'The official endpoint returned HTTP ' + response.status + '.');
      if (!/^application\/json\b/i.test(response.headers.get('content-type') || '')) malformed();
      const data = await response.json();
      return { data, source: url, fetchedAt: new Date(now()).toISOString() };
    } catch (error) {
      if (signal.aborted || error?.name === 'TimeoutError') fail('TIMEOUT', 'The official endpoint did not respond within 12 seconds.');
      if (['INVALID_RESPONSE', 'HTTP_ERROR'].includes(error?.code)) throw error;
      if (error instanceof SyntaxError) malformed();
      fail('NETWORK_ERROR', 'Could not reach the official Astarter endpoint.');
    }
  }

  if (command === 'doctor' || command === 'status') {
    const { data, ...meta } = await get(proofPath + '?tool=1');
    if (data?.name !== toolName || data.version !== version || data.readOnly !== true ||
        data.request?.method !== 'GET' || data.request?.path !== proofPath ||
        data.request?.query?.brief !== '1' || data.assetCatalog !== proofPath) malformed();
    return { ...meta, status: 'ok', service: 'Deep Brain', tool: data.name, version: data.version, readOnly: true };
  }

  if (command === 'markets') {
    const symbol = arg?.toUpperCase();
    if (symbol !== undefined && !symbolPattern.test(symbol)) fail('USAGE', 'Provide a market symbol, for example BTC.');
    const { data, ...meta } = await get('/api/atlas/prices' + (symbol ? '?symbol=' + symbol : ''));
    if (data?.configured === false) fail('UNAVAILABLE', 'Atlas Oracle quotes are currently unavailable.');
    if (data?.configured !== true || !data.prices || typeof data.prices !== 'object' || Array.isArray(data.prices)) malformed();
    const rows = Object.entries(data.prices);
    if (!rows.length) fail('NO_QUOTES', 'No quote was returned for this selection.');
    if (data.source !== 'Atlas Oracle' || !Array.isArray(data.missing) || !data.missing.every(s => typeof s === 'string' && symbolPattern.test(s))) malformed();
    const quotes = rows.map(([id, row]) => {
      if (!symbolPattern.test(id) || (symbol && id !== symbol) || !Number.isFinite(row?.price) || row.price <= 0 ||
          !Number.isSafeInteger(row.timestamp) || row.timestamp <= 0 || row.timestamp > 8640000000000 ||
          typeof row.quote !== 'string' || !symbolPattern.test(row.quote)) malformed();
      return { symbol: id, price: row.price, quoteCurrency: row.quote, asOf: new Date(row.timestamp * 1000).toISOString() };
    });
    return { ...meta, provider: data.source, quotes, missing: data.missing };
  }

  if (command === 'research') {
    if (arg !== undefined && !assetKey(arg)) fail('USAGE', 'Use a catalog asset key such as coin:bitcoin. Run research to list supported keys.');
    const { data, ...meta } = await get(proofPath + (arg ? '?brief=1&asset=' + encodeURIComponent(arg) : ''));
    if (!arg) {
      if (!Array.isArray(data?.assets) || !timestamp(data.retrievedAt) ||
          !data.assets.every(asset => assetKey(asset?.key) && typeof asset.symbol === 'string' && typeof asset.venue === 'string')) malformed();
      return { ...meta, asOf: data.retrievedAt, assets: data.assets.map(({ key, symbol, market, quote, venue }) => ({ key, symbol, market, quote, venue })) };
    }
    if (data?.version !== version || data.assetKey !== arg || data.access !== 'read_only' || data.liveAuthorized !== false ||
        !timestamp(data.asOf) || typeof data.status !== 'string') malformed();
    return { ...meta, brief: data };
  }
  fail('USAGE', 'Unknown command. See node astarter.mjs help.');
}

const entry = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 20) fail('NODE_VERSION', 'Astarter CLI requires Node.js 20 or newer.');
    const output = await run(process.argv.slice(2));
    console.log(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.code || 'CLI_ERROR', message: error.message }));
    process.exitCode = 1;
  }
}
