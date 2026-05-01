# awethmax-monitor

Monitors the recommended `maxTargetAweth` for the Arbitrum aWETH/WETH Uniswap V3 pool and updates the executor contract only when the recommendation deviates from the on-chain value by more than `UPDATE_DEVIATION_BPS`.

Default threshold is `2000` bps, meaning strictly more than 20%. The monitor runs every 10 minutes by default, evaluates immediately after a successful `ArbitrageExecuted` event from the executor contract, and re-evaluates immediately when any configured fee pool emits `Swap`, `Mint`, `Burn`, `Collect`, or `Flash`.

If the WebSocket connection closes or errors, the monitor tears down the old event listeners and reconnects after 5 seconds. The periodic interval continues to run as a fallback while WebSocket events are unavailable.

Quote scans are batched through Multicall3. With the defaults, the monitor first scans `0.5` aWETH steps through `5` aWETH. If that low range has no profitable quote, the evaluation stops there. If the low range is profitable, each fee tier continues with `5` aWETH steps above that and stops at the first high-range batch with no profitable quotes; the fine scan then uses `0.1` aWETH steps around the best coarse result and is about 11 RPC calls per configured fee. If a public RPC rejects a Multicall3 batch, that batch is retried as single quoter calls without logging noisy split-batch warnings. Pool/executor events are deduplicated by transaction hash and debounced for 2 seconds before triggering an evaluation.

Set `MONITOR_INTERVAL_MS=0` to disable the periodic fallback and run from startup plus WebSocket events only.

If no profitable quote exists, the monitor recommends `1 wei` instead of `0`, because `0` means unlimited on the executor contract.

## Server Run

Create `.env` in the same directory as `docker-compose.yml`:

```env
OWNER_PRIVATE_KEY=0xYOUR_EXECUTOR_OWNER_PRIVATE_KEY
TX_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
WS_RPC_URL=wss://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
POOL_FEES=100,500

BARK_BASE_URL=https://api.day.app
BARK_DEVICE_KEY=YOUR_BARK_DEVICE_KEY
BARK_TITLE=aWETH Max Monitor
BARK_GROUP=AAVE_ARB
```

Run:

```bash
docker compose up -d
docker compose logs -f
```

## Build

GitHub Actions builds and pushes:

```text
ghcr.io/wanglz111/awethmax-monitor:latest
```

It also uploads a deploy artifact containing `docker-compose.yml` and `.env.example`.

## Config

- `OWNER_PRIVATE_KEY`: private key for the executor owner; required unless `DRY_RUN=true`.
- `TX_RPC_URL`: reliable Arbitrum HTTP RPC URL used for owner checks and update transactions.
- `WS_RPC_URL`: Arbitrum WebSocket RPC URL used to listen for successful executor `ArbitrageExecuted` events and Uniswap V3 pool events.
- Quote scans always try the hard-coded Arbitrum public RPC `https://arb1.arbitrum.io/rpc` first.
- `QUOTE_FALLBACK_RPC_URL`: optional private HTTP RPC fallback for quote scans. Defaults to `QUOTE_RPC_URL` for backward compatibility, then `TX_RPC_URL`.
- `BARK_DEVICE_KEY`: enables Bark notifications when set.
- `BARK_TITLE`: default notification title, default `aWETH Max Monitor`.
- `BARK_GROUP`: Bark group, default `AAVE_ARB`.
- `EXECUTOR_CONTRACT_ADDRESS`: executor proxy address.
- `POOL_ADDRESS`: optional Uniswap V3 pool address. Leave unset to auto-resolve the WETH/aWETH pools from `POOL_FEES`.
- `POOL_FEES`: comma-separated Uniswap V3 pool fee tiers to scan and listen to, for example `100,500`.
- `POOL_FEE`: backward-compatible single fee tier, default `500`, used only when `POOL_FEES` is unset.
- `MAX_AWETH_SCAN_ETH`: maximum aWETH output to scan, default `400`.
- `LOW_COARSE_MAX_ETH`: upper bound for low-range coarse scans, default `5`.
- `LOW_COARSE_STEP_ETH`: low-range coarse scan step size, default `0.5`.
- `COARSE_STEP_ETH`: high-range coarse scan step size, default `5`.
- `FINE_STEP_ETH`: fine scan step size, default `0.1`.
- `FINE_WINDOW_ETH`: fine scan window around the best coarse result, default `10`.
- `QUOTE_BATCH_SIZE`: number of quote calls per Multicall3 request, default `20`.
- `QUOTE_CONCURRENCY`: number of Multicall3 quote batches to run concurrently, default `6`.
- `EVENT_DEBOUNCE_MS`: delay used to merge pool/executor events before re-evaluating, default `2000`.
- `MONITOR_INTERVAL_MS`: monitor interval, default `600000`; set `0` to disable the interval and only evaluate on startup/events.
