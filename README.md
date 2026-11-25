# Astarter at BNB Bangkok

**Astarter turns AI research into trade plans you can test before committing capital.**

LensWave, Astarter’s AI Trading OS, connects market research, strategy design, risk review, and simulation. At BNB Bangkok, we’re applying that workflow to a BNB Chain swap. The prototype will check a live PancakeSwap quote against a market reference and show whether the trade is ready for review, needs a fresh quote, or falls outside the allowed price range.

## From quote to approval

Enter a trade size for BNB/USDT. The preflight will compare the amount-specific PancakeSwap quote with the reference on the same price basis. The review screen will show the expected output, the data sources and timestamps, and the rule behind the result.

| Condition | What the trader sees |
| --- | --- |
| Fresh data and a price within the allowed range | The proposal is ready for user review. |
| An expired quote or an unavailable reference | The proposal pauses and asks for fresh data. |
| A price difference beyond the allowed limit | The proposal pauses and shows the difference. |

## What we’re building in Bangkok

**Existing product.** LensWave supports strategy review and simulated trading. Astarter is developing AI Wealth for portfolio allocation and monitoring on the same research and risk foundation.

**Verified on BNB Chain.** A read-only call to the PancakeSwap V2 router returns an amount-specific WBNB/USDT quote on BNB Smart Chain mainnet.

**Planned hackathon work.** Connect a live CoinMarketCap or Atlas reference price, apply quote freshness and price-deviation rules, and surface each decision in the trade review flow. This build targets the Developer Track and the CoinMarketCap × Atlas Challenge. [See the BNB Bangkok brief](https://www.hackquest.io/zh-cn/hackathons/BNB-Bangkok).

<details>
<summary>Reproduce the live PancakeSwap quote</summary>

Run this read-only command with Foundry to quote 1 WBNB into USDT.

```bash
cast call 0x10ED43C718714eb63d5aA57B78B54704E256024E \
  'getAmountsOut(uint256,address[])(uint256[])' \
  1000000000000000000 \
  '[0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c,0x55d398326f99059fF775485246999027B3197955]' \
  --rpc-url https://bsc-dataseed.bnbchain.org
```

The second returned value is the expected USDT output in base units at the time of the query.

</details>
