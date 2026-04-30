# awethmax-monitor

Monitors the recommended `maxTargetAweth` for the Arbitrum aWETH/WETH Uniswap V3 pool and updates the executor contract only when the recommendation deviates from the on-chain value by more than `UPDATE_DEVIATION_BPS`.

Default threshold is `2000` bps, meaning strictly more than 20%. The monitor runs every 10 minutes by default, evaluates immediately after a successful `ArbitrageExecuted` event from the executor contract, and re-evaluates immediately when the 500 fee pool emits `Swap`, `Mint`, `Burn`, `Collect`, or `Flash`.

If the WebSocket connection closes or errors, the monitor tears down the old event listeners and reconnects after 5 seconds. The periodic interval continues to run as a fallback while WebSocket events are unavailable.

Quote scans are batched through Multicall3. With the defaults, the coarse scan is about 4 RPC calls and the fine scan is about 2 RPC calls, while still simulating the same underlying quoter work. Pool/executor events are deduplicated by transaction hash and debounced for 2 seconds before triggering an evaluation.

Set `MONITOR_INTERVAL_MS=0` to disable the periodic fallback and run from startup plus WebSocket events only.

If no profitable quote exists, the monitor recommends `1 wei` instead of `0`, because `0` means unlimited on the executor contract.

## Server Run

Create `.env` in the same directory as `docker-compose.yml`:

```env
OWNER_PRIVATE_KEY=0xYOUR_EXECUTOR_OWNER_PRIVATE_KEY
TX_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
WS_RPC_URL=wss://arb-mainnet.g.alchemy.com/v2/YOUR_KEY

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
- `POOL_ADDRESS`: optional Uniswap V3 pool address. Leave unset to auto-resolve the WETH/aWETH pool from `POOL_FEE`.
- `POOL_FEE`: Uniswap V3 pool fee tier, default `500`.
- `QUOTE_BATCH_SIZE`: number of quote calls per Multicall3 request, default `20`.
- `QUOTE_CONCURRENCY`: number of Multicall3 quote batches to run concurrently, default `6`.
- `EVENT_DEBOUNCE_MS`: delay used to merge pool/executor events before re-evaluating, default `2000`.
- `MONITOR_INTERVAL_MS`: monitor interval, default `600000`; set `0` to disable the interval and only evaluate on startup/events.
