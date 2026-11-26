# Verify a tokenized equity on BNB Chain

Ask Astarter for a price on NVIDIA’s tokenized certificate and you can verify the asset, the oracle and the time of its last update. NVDAB is a bStock issued by BTech Holdings Limited that gives its holder exposure to NVIDIA shares. [Binance listing and token contract](https://www.binance.com/en-AU/support/announcement/detail/5646e3f9ea6b4c989cb76aa18bd99245)

| What you are checking | Identity | How to inspect it |
| --- | --- | --- |
| Token on BNB Smart Chain | `0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436` | Read the token’s `symbol()` on chain ID 56. It returns `NVDAB`. [Token contract](https://bscscan.com/token/0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436) |
| USD quote returned by Astarter | Atlas feed **934** | The dApp requests a Pull report and returns its price, feed ID and source timestamp. [Public quote](https://dapp.ipfund.art/api/atlas/prices?symbol=NVDAB) · [Feed 934](https://atlasoracle.io/feeds/934) |
| Independently published on-chain quote | Atlas feed **1005**, `0xf25af12920d408baf6211e9e90eda89df3d8ccda` | Read the Push reference contract’s latest round. This feed has its own market sources and update time. [Feed 1005](https://atlasoracle.io/feeds/1005) · [Oracle contract](https://bscscan.com/address/0xf25af12920d408baf6211e9e90eda89df3d8ccda) |

## Read both contracts at one block

With Foundry’s `cast`, run these read-only calls against the same BNB Smart Chain block. They require no wallet or API key.

```sh
rpc=https://bsc-dataseed.bnbchain.org
token=0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436
oracle=0xf25af12920d408baf6211e9e90eda89df3d8ccda

cast chain-id --rpc-url "$rpc"
block=$(cast block-number --rpc-url "$rpc")
echo "$block"
cast call "$token" 'symbol()(string)' --rpc-url "$rpc" --block "$block"
cast call "$oracle" 'decimals()(uint8)' --rpc-url "$rpc" --block "$block"
cast call "$oracle" 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' \
  --rpc-url "$rpc" --block "$block"
```

Divide the second value in the round by `10^18` for the USD price. The fourth value is the update time in Unix seconds. Compare it with the timestamp of Astarter’s Pull quote. These observations establish what the oracles reported. A fill or realized return requires a separate execution receipt with quantities and costs. [Market data integration](../COINMARKETCAP-ATLAS/README.md) · [Paper execution checks](../src/deep-brain/brain-execution-invariants.mjs)
