# awethmax-monitor

Monitors the recommended `maxTargetAweth` for the Arbitrum aWETH/WETH pool and updates the executor contract only when the recommendation deviates from the on-chain value by more than `UPDATE_DEVIATION_BPS`.

Default threshold is `2000` bps, meaning strictly more than 20%.

If no profitable quote exists, the monitor recommends `1 wei` instead of `0`, because `0` means unlimited on the executor contract.

## Server Run

Create `.env` in the same directory as `docker-compose.yml`:

```env
OWNER_PRIVATE_KEY=0xYOUR_EXECUTOR_OWNER_PRIVATE_KEY
HTTP_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
EXECUTOR_CONTRACT_ADDRESS=0x860Ad26c581B533016aC62152De040649208508B
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
- `HTTP_RPC_URL`: Arbitrum HTTP RPC URL.
- `EXECUTOR_CONTRACT_ADDRESS`: executor proxy address.
- `POOL_FEE`: Uniswap V3 pool fee, default `500`.
- `MAX_AWETH_SCAN_ETH`: upper scan bound, default `400`.
- `COARSE_STEP_ETH`: coarse scan step, default `5`.
- `FINE_STEP_ETH`: fine scan step, default `0.5`.
- `FINE_WINDOW_ETH`: fine scan window around best coarse quote, default `10`.
- `QUOTE_CONCURRENCY`: concurrent quote calls, default `6`.
- `MONITOR_INTERVAL_MS`: monitor interval, default `60000`; set `0` to run once.
- `UPDATE_DEVIATION_BPS`: update threshold, default `2000`.
- `DRY_RUN`: log updates without sending transactions.

