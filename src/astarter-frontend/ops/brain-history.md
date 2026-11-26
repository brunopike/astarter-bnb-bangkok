# Public history updates

The public repository runs the history workflow on main at 05:37 UTC each day. A maintainer can also run **Refresh public Brain history** from the Actions tab. The job uses the repository's built-in write token. Branch protection must permit this repository's authorized Actions publisher to push data commits. Neither a cloud key nor a wallet is required. A partial source outage leaves previous records in place. The job stages only files referenced by validated indexes, publishes verified changes, and reports incomplete updates as failures.

The standard public Ubuntu runner provides four CPUs, 16 GB of memory and 14 GB of disk. GitHub limits a hosted job to six hours. The workflow allows three hours for daily increments; the release already contains the initial history. See [runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) and [Actions limits](https://docs.github.com/en/actions/reference/limits).

## Hackathon server

Install the released script and units using the normal deployment process. Create the data directory once, then enable the hourly timer.

```sh
sudo install -d -o ubuntu -g ubuntu -m 0755 /home/ubuntu/.local/share/astarter/history
sudo install -m 0644 /var/www/astarter/ops/astarter-brain-history.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now astarter-brain-history.timer
sudo systemctl start astarter-brain-history.service
journalctl -u astarter-brain-history.service -n 20
```

Each run resolves public main once. All subsequent reads use that immutable Git SHA. The mirror checks index Git blob IDs and data SHA-256 digests. Matching deployment files under /var/www/astarter/brain-evidence seed the first release. Later generations share already verified immutable files. The mirror installs indexes after the data and atomically switches both data directories together. Failed downloads leave the prior release active.

The application reads /home/ubuntu/.local/share/astarter/history/archive and /home/ubuntu/.local/share/astarter/history/tradfi. The mirror owns these two links. To install a specific public revision, run the script as the service user with `--sha FULL_40_DIGIT_COMMIT`. The runtime uses Python's standard library and retains the previous release locally.

## Solana coverage

SOL archives one finalized, time-stamped mainnet-beta block per covered UTC day. Historical imports read bounded byte ranges from Yellowstone Old Faithful, validate the DAG-CBOR content IDs and count the transactions referenced by the block's entries. A final transaction's block position, when provided, gives the same count. RPC reads use the number of transaction signatures in the finalized block. Both include validator votes and failed transactions. A skipped slot, unknown block time or failed read produces no observation. The adapter starts on October 7, 2020, the earliest supported day with a verified UTC timestamp in this import. The chain was already running before this coverage begins. Each daily shard carries its native explorer link and its raw-archive range or RPC provenance. See the [Old Faithful schema](https://github.com/rpcpool/yellowstone-faithful/blob/main/ledger.ipldsch) and [Solana getBlock method](https://solana.com/developers/docs/rpc/http/getblock).
