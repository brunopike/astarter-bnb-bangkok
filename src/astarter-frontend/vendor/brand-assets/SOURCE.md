# UI identity assets

Retrieved 2026-10-29. Cached for brand identification, not financial data or proof of an API connection.

- Eleven crypto SVGs come from spothq/cryptocurrency-icons (CC0), with the license retained under vendor/crypto-icons/. SOL uses the official unchanged gradient mark; see its source notice there.
- Additional coin and exchange logos use the image URLs returned by CoinGecko public metadata. TON uses the Trust Wallet blockchain asset; BitMEX uses its official favicon. Exact source URLs and file hashes are in sources.json. Brand marks remain the property of their respective owners.
- SPX, NDX, XAU, DXY, US10Y and USD use local asset-category glyphs, not invented issuer logos.
- 2026-11-02: These six instrument marks now distinguish ticker/index identity, gold bullion, dollar index and 10-year Treasury yield. They are Astarter-drawn instrument identifiers, not Nasdaq/S&P issuer logos, SPY/QQQ ETF logos or tokenized-asset brands. NDX is Nasdaq-100, SPX is S&P 500, and XAU is spot gold priced per ounce. They are served by the same identity resolver as all other asset surfaces.
- The public metadata response for the-open-network currently identified GRAM, so it was not mapped to the TON fixture. No quote or asset identity was changed.
- The precached subset is served locally through an exact static allowlist. New API metadata uses the normalized image_url field and the two approved CoinGecko image CDNs, with anonymous CORS and no-referrer. Unknown identities are not matched by symbol. No provider credentials or arbitrary logo URLs are accepted.

The local 30-token subset is a fallback cache, not a supported-universe limit. Six additional real public metadata samples (ONDO/WLD/POL/TIA/PENDLE/AR) are stored without prices in test-fixtures/api-logo-samples-20261029.json and tested through the same resolver. API identity metadata, not this static list, supplies new logos. Long-tail metadata lookup remains a separately integrated data capability.
