export const SOCIAL_POST_WINDOW_MS = 86_400_000;
export const DIRECT_SOCIAL_REFRESH_MS = 60_000;
export const DIRECT_SOCIAL_VALID_MS = 180_000;
export const RECENT_SOCIAL_SCOPE = 'SOCIAL_RECENT_POSTS';
export const RECENT_SOCIAL_PROVIDERS = Object.freeze(['lunarcrush-v4', 'bluesky-latest-v1', 'nostr-relay-v1']);
export const SOCIAL_PLATFORMS = Object.freeze(['X', 'Bluesky', 'Nostr', 'Reddit', 'YouTube', 'Instagram', 'TikTok', 'Facebook']);

// Match the original text, not the search query. Ambiguous tickers require a cashtag or a project name.
const topics = {
 BTC: ['Bitcoin', /\b(?:bitcoins?|BTC|lightning network)\b|比特[币幣]|ビットコイン|비트코인|биткоин/iu],
 ETH: ['Ethereum', /\b(?:ethereum|ether|ETH)\b|以太[坊幣币]|イーサリアム|이더리움|эфириум/iu],
 SOL: ['Solana', /\bsolana\b|\$SOL\b|索拉[娜纳納]|ソラナ/iu],
 XRP: ['XRP', /\bXRP\b|瑞波[币幣]/iu],
 BNB: ['"BNB Chain"', /\bBNB\s+(?:smart\s+)?chain\b|\$BNB\b|币安币|幣安幣/iu],
 DOGE: ['Dogecoin', /\bdogecoin\b|\$DOGE\b|狗狗[币幣]|ドージコイン/iu],
 ADA: ['Cardano', /\bcardano\b|\$ADA\b|卡尔达诺|卡爾達諾/iu],
 LINK: ['Chainlink', /\bchainlink\b(?!\s+(?:fenc\w*|mesh|gate)\b)|\$LINK\b/iu],
 AVAX: ['Avalanche AVAX', /\bAVAX\b|\bavalanche\s+(?:network|blockchain|protocol)\b/iu],
 SUI: ['"Sui Network"', /\bSui\s+(?:network|blockchain|token)\b|\$SUI\b/iu],
 HYPE: ['Hyperliquid', /\bhyperliquid\b|\$HYPE\b/iu],
 ARB: ['Arbitrum', /\barbitrum\b|\$ARB\b/iu],
 XMR: ['Monero', /\bmonero\b|\bXMR\b|门罗[币幣]|門羅[币幣]/iu],
 ZEC: ['Zcash', /\bzcash\b|\bZEC\b/iu],
 AAVE: ['Aave', /\bAave\b/iu],
 UNI: ['Uniswap', /\buniswap\b|\$UNI\b/iu]
};
export const SOCIAL_SYMBOLS = Object.freeze(Object.keys(topics));
export const SOCIAL_SEARCHES = Object.freeze(Object.entries(topics).map(([symbol, [query]]) => Object.freeze({symbol, query})));
export const BLUESKY_DID = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]{3,180})$/;
export const BLUESKY_HANDLE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
export const BLUESKY_RKEY = /^[a-zA-Z0-9_-]{1,64}$/;
export const NOSTR_HEX = /^[a-f0-9]{64}$/;
export const blueskyProfile = did => 'https://bsky.app/profile/' + did;
export const nostrPermalink = id => 'https://primal.net/e/' + id;
export const shortSocialKey = key => key.slice(0, 6) + '…' + key.slice(-4);

export function detectSocialSymbols(text) {
 const body = text.replace(/https?:\/\/\S+/giu, '');
 return SOCIAL_SYMBOLS.filter(symbol => topics[symbol][1].test(body));
}

export function socialFiltersFromLocation(params) {
 const symbol = params.get('social_asset'), platform = params.get('social_platform');
 return {
  ...(SOCIAL_SYMBOLS.includes(symbol) ? {symbol} : {}),
  ...(SOCIAL_PLATFORMS.includes(platform) ? {platform} : {})
 };
}
