"""Combine audited chain summaries for the Brain Layer RWA archive."""

import argparse
import json
import tempfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUMMARY_DIR = ROOT / "data/research-archives"
CHAINS = {1: "Ethereum", 56: "BNB Chain"}


def translated(en, zh):
    return {"en": en, "zh": zh}


def combine(parts):
    totals = Counter()
    contracts = {}
    samples = []
    networks = {}
    readers = {}
    stats = []
    for data in parts:
        chain = data["chainId"]
        if chain not in CHAINS or chain in networks:
            raise ValueError(f"Unknown or duplicated chain {chain}")
        kinds = Counter(data["eventCounts"])
        assets = data["assetContracts"]
        if (
            set(kinds) - {"transfer", "mint", "burn"}
            or any(type(n) is not int or n < 0 for n in kinds.values())
            or sum(kinds.values()) != data["count"]
            or data["fromBlock"] > data["toBlock"]
        ):
            raise ValueError(f"Invalid event totals on {chain}")
        asset_kinds = Counter()
        for item in assets:
            key = (chain, item["address"].lower())
            if key in contracts or sum(item["eventsByKind"].values()) != item["count"]:
                raise ValueError(f"Invalid contract breakdown: {key}")
            asset_kinds.update(item["eventsByKind"])
            contracts[key] = item
        if asset_kinds != kinds:
            raise ValueError(f"Contract counts disagree with chain totals on {chain}")
        totals.update(kinds)
        networks[chain] = {
            key: data[key]
            for key in (
                "chainId",
                "fromBlock",
                "toBlock",
                "asOf",
                "startDate",
                "endDate",
                "count",
                "sourceUrl",
                "archiveManifestSha256",
            )
        }
        networks[chain]["sourceUrls"] = data.get("sourceUrls", [data["sourceUrl"]])
        for url in networks[chain]["sourceUrls"]:
            name = "SQD Portal" if "portal.sqd.dev" in url else "BlockPI RPC"
            readers[url] = {
                "name": f"{CHAINS[chain]} · {name}",
                "url": "https://docs.blockpi.io" if name == "BlockPI RPC" else url,
            }
        stats.append({"label": CHAINS[chain], "value": data["count"]})
        # Show one recent example per contract, so a high-volume asset cannot crowd out others.
        represented = set()
        for sample in sorted(
            data["samples"],
            key=lambda row: (row["block"], row["logIndex"]),
            reverse=True,
        ):
            key = (chain, sample["contract"].lower())
            if key not in contracts or not sample["id"].startswith(f"{chain}:"):
                raise ValueError("Sample chain or contract mismatch")
            if key in represented:
                continue
            represented.add(key)
            event = (
                ("Mint", "铸造")
                if int(sample["from"], 16) == 0
                else (
                    ("Burn", "销毁")
                    if int(sample["to"], 16) == 0
                    else ("Transfer", "转移")
                )
            )
            prefix = f"{CHAINS[chain]} · {contracts[key]['symbol']}"
            samples.append(
                {
                    **sample,
                    "label": translated(
                        f"{prefix} · {event[0]}", f"{prefix} · {event[1]}"
                    ),
                }
            )
    if (
        networks.keys() != CHAINS.keys()
        or not samples
        or len({row["id"] for row in samples}) != len(samples)
    ):
        raise ValueError("Incomplete archive or repeated sample")
    count = sum(totals.values())
    for kind, en, zh in (
        ("transfer", "Address transfers", "普通转移"),
        ("mint", "Mints", "铸造"),
        ("burn", "Burns", "销毁"),
    ):
        stats.append({"label": translated(en, zh), "value": totals[kind]})
    active = [asset for asset in contracts.values() if asset["count"] > 0]
    leader = max(active, key=lambda asset: asset["count"])
    share = leader["count"] / count
    periods = " · ".join(
        f"{CHAINS[k]} {row['startDate']} – {row['endDate']}"
        for k, row in networks.items()
    )
    return {
        "schemaVersion": 1,
        "count": count,
        "startDate": min(row["startDate"] for row in networks.values()),
        "endDate": max(row["endDate"] for row in networks.values()),
        "asOf": max(row["asOf"] for row in networks.values()),
        "unit": translated("Onchain events", "链上事件"),
        "sourceName": "ERC-20 · Transfer",
        "sourceUrl": "https://eips.ethereum.org/EIPS/eip-20",
        "sources": [
            *readers.values(),
            {"name": "Paxos · PAXG", "url": "https://www.paxos.com/assets/paxg"},
            {"name": "Tether Gold · XAUT", "url": "https://gold.tether.to/"},
            {
                "name": "Ondo · USDY / OUSG",
                "url": "https://docs.ondo.finance/addresses",
            },
            {
                "name": "Ondo · Tokenized Stocks & ETFs",
                "url": "https://ondo.finance/ondo-stocks",
            },
        ],
        "methodology": translated(
            "One ERC-20 Transfer log from an issuer-listed contract, identified by chain, transaction hash and log index. "
            "Minting and burning are classified by the zero address. Fee and zero-amount transfer events are included. "
            "An onchain transfer alone does not establish a sale or an offchain settlement. "
            + periods,
            "以链 ID、交易哈希和日志序号识别发行方合约的每条 Transfer 事件。按零地址区分铸造、销毁及普通转移，含手续费及零金额转移事件。"
            "仅凭链上转移无法确认是否产生成交或链下结算。各链覆盖区间为 " + periods,
        ),
        "analysis": translated(
            f"{len(active)} active contracts cover gold, Treasuries, tokenized equities and funds. "
            f"{leader['symbol']} accounts for {share:.1%} of the archived events. Shares measure activity within these block ranges.",
            f"样本涵盖黄金、美债、代币化股票和基金，共 {len(active)} 个有活动的合约。"
            f"{leader['symbol']} 占本批事件的 {share:.1%}。此占比衡量上述区块范围内的活动频次。",
        ),
        "stats": stats,
        "networks": list(networks.values()),
        "assetContracts": [
            {"chainId": chain, **asset} for (chain, _), asset in contracts.items()
        ],
        "samples": sorted(samples, key=lambda row: row["date"], reverse=True),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ethereum", type=Path, default=SUMMARY_DIR / "rwa-chain.json")
    parser.add_argument("--bnb", type=Path, default=SUMMARY_DIR / "rwa-bnb.json")
    parser.add_argument("--output", type=Path, default=SUMMARY_DIR / "rwa.json")
    args = parser.parse_args()
    result = combine(
        [json.loads(path.read_text()) for path in (args.ethereum, args.bnb)]
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=args.output.parent, delete=False
    ) as out:
        json.dump(result, out, ensure_ascii=False, indent=2)
        out.write("\n")
    staged = Path(out.name)
    staged.chmod(0o644)
    staged.replace(args.output)
    print(
        f"{result['count']:,} unique RWA events across {len(result['networks'])} chains"
    )
