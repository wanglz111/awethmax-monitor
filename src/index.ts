import "dotenv/config";

import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatEther,
  getAddress,
  isAddress,
  parseEther
} from "ethers";

const DEFAULT_RPC_URL = "https://arb1.arbitrum.io/rpc";
const DEFAULT_EXECUTOR_CONTRACT_ADDRESS = "0x860Ad26c581B533016aC62152De040649208508B";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const AWETH = "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8";
const MIN_SQRT_RATIO_PLUS_ONE = 4_295_128_740n;
const SCALE_BPS = 10_000n;
const INPUT_BUFFER_BPS = 1n;

const QUOTER_ABI = [
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
];

const EXECUTOR_ABI = [
  "function owner() view returns (address)",
  "function maxTargetAweth() view returns (uint256)",
  "function setMaxTargetAweth(uint256 newMaxTargetAweth)"
];

type Quote = {
  reason: "profitable-quote" | "no-profitable-quote";
  outEth: number;
  amountOut: bigint;
  amountIn: bigint;
  maxIn: bigint;
  bufferedProfit: bigint;
  profitBps: bigint;
  sqrtPriceX96After: bigint;
  ticksCrossed: number;
  gasEstimate: number;
};

type Config = {
  rpcUrl: string;
  executorAddress: string;
  privateKey: string | null;
  poolFee: number;
  maxEth: number;
  coarseStepEth: number;
  fineStepEth: number;
  fineWindowEth: number;
  concurrency: number;
  intervalMs: number;
  deviationBps: number;
  dryRun: boolean;
};

function timestamp(): string {
  return new Date().toISOString();
}

function log(message: string): void {
  console.log(`[${timestamp()}] ${message}`);
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseBool(name: string, fallback: boolean): boolean {
  const value = optional(name);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseNumber(name: string, fallback: number): number {
  const value = optional(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive number in ${name}: ${value}`);
  }
  return parsed;
}

function parseInteger(name: string, fallback: number): number {
  const value = optional(name);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer in ${name}: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(name: string, fallback: number): number {
  const value = optional(name);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer in ${name}: ${value}`);
  }
  return parsed;
}

function parseAddress(name: string, fallback: string): string {
  const value = optional(name) ?? fallback;
  if (!isAddress(value)) {
    throw new Error(`Invalid address in ${name}: ${value}`);
  }
  return getAddress(value);
}

function loadConfig(): Config {
  const dryRun = parseBool("DRY_RUN", false);

  return {
    rpcUrl: optional("HTTP_RPC_URL") ?? optional("RPC_URL") ?? DEFAULT_RPC_URL,
    executorAddress: parseAddress("EXECUTOR_CONTRACT_ADDRESS", DEFAULT_EXECUTOR_CONTRACT_ADDRESS),
    privateKey: dryRun ? optional("OWNER_PRIVATE_KEY") : required("OWNER_PRIVATE_KEY"),
    poolFee: parseInteger("POOL_FEE", 500),
    maxEth: parseNumber("MAX_AWETH_SCAN_ETH", 400),
    coarseStepEth: parseNumber("COARSE_STEP_ETH", 5),
    fineStepEth: parseNumber("FINE_STEP_ETH", 0.5),
    fineWindowEth: parseNumber("FINE_WINDOW_ETH", 10),
    concurrency: parseInteger("QUOTE_CONCURRENCY", 6),
    intervalMs: parseNonNegativeInteger("MONITOR_INTERVAL_MS", 60_000),
    deviationBps: parseInteger("UPDATE_DEVIATION_BPS", 2_000),
    dryRun
  };
}

function format(value: bigint): string {
  return Number(formatEther(value)).toFixed(6);
}

function range(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end + step / 10; value += step) {
    values.push(Number(value.toFixed(8)));
  }
  return values;
}

async function mapLimit<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return output;
}

function overDeviationThreshold(next: bigint, current: bigint, thresholdBps: number): boolean {
  if (current === 0n) return next !== 0n;
  const delta = next > current ? next - current : current - next;
  return delta * SCALE_BPS > current * BigInt(thresholdBps);
}

function deviationBps(next: bigint, current: bigint): string {
  if (current === 0n) return next === 0n ? "0" : "inf";
  const delta = next > current ? next - current : current - next;
  return ((delta * SCALE_BPS) / current).toString();
}

function fallbackQuote(): Quote {
  return {
    reason: "no-profitable-quote",
    outEth: 0,
    amountOut: 1n,
    amountIn: 0n,
    maxIn: 0n,
    bufferedProfit: 0n,
    profitBps: 0n,
    sqrtPriceX96After: 0n,
    ticksCrossed: 0,
    gasEstimate: 0
  };
}

async function findBestQuote(provider: JsonRpcProvider, config: Config): Promise<Quote> {
  const quoter = new Contract(QUOTER_V2, QUOTER_ABI, provider);

  async function quote(outEth: number): Promise<Quote | null> {
    const amountOut = parseEther(String(outEth));

    try {
      const [amountIn, sqrtPriceX96After, ticksCrossed, gasEstimate] =
        await quoter.quoteExactOutputSingle.staticCall({
          tokenIn: WETH,
          tokenOut: AWETH,
          amount: amountOut,
          fee: config.poolFee,
          sqrtPriceLimitX96: MIN_SQRT_RATIO_PLUS_ONE
        });
      const maxIn = amountIn + (amountIn * INPUT_BUFFER_BPS) / SCALE_BPS;
      const bufferedProfit = amountOut - maxIn;

      return {
        reason: "profitable-quote",
        outEth,
        amountOut,
        amountIn,
        maxIn,
        bufferedProfit,
        profitBps: (bufferedProfit * SCALE_BPS) / amountOut,
        sqrtPriceX96After,
        ticksCrossed: Number(ticksCrossed),
        gasEstimate: Number(gasEstimate)
      };
    } catch {
      return null;
    }
  }

  const coarseQuotes = await mapLimit(
    range(config.coarseStepEth, config.maxEth, config.coarseStepEth),
    config.concurrency,
    quote
  );
  const validCoarse = coarseQuotes
    .filter((item): item is Quote => item !== null)
    .filter((item) => item.sqrtPriceX96After !== MIN_SQRT_RATIO_PLUS_ONE && item.bufferedProfit > 0n)
    .sort((a, b) => (a.bufferedProfit < b.bufferedProfit ? 1 : -1));

  if (validCoarse.length === 0) {
    return fallbackQuote();
  }

  const center = validCoarse[0].outEth;
  const fineStart = Math.max(config.fineStepEth, center - config.fineWindowEth);
  const fineEnd = Math.min(config.maxEth, center + config.fineWindowEth);
  const fineQuotes = await mapLimit(
    range(fineStart, fineEnd, config.fineStepEth),
    config.concurrency,
    quote
  );
  const validFine = fineQuotes
    .filter((item): item is Quote => item !== null)
    .filter((item) => item.sqrtPriceX96After !== MIN_SQRT_RATIO_PLUS_ONE && item.bufferedProfit > 0n)
    .sort((a, b) => (a.bufferedProfit < b.bufferedProfit ? 1 : -1));

  return validFine[0] ?? validCoarse[0];
}

async function runOnce(provider: JsonRpcProvider, executor: Contract, config: Config): Promise<void> {
  const best = await findBestQuote(provider, config);
  const current = BigInt(await executor.maxTargetAweth());
  const shouldUpdate = overDeviationThreshold(best.amountOut, current, config.deviationBps);

  log(
    [
      `recommended=${format(best.amountOut)}aWETH`,
      `reason=${best.reason}`,
      `onchain=${format(current)}aWETH`,
      `deltaBps=${deviationBps(best.amountOut, current)}`,
      `thresholdBps=${config.deviationBps}`,
      `bufferedProfit=${format(best.bufferedProfit)}WETH`,
      `profitBps=${best.profitBps.toString()}`,
      `ticks=${best.ticksCrossed}`,
      `quoteGas=${best.gasEstimate}`,
      `update=${shouldUpdate}`
    ].join(" ")
  );

  if (!shouldUpdate) return;

  if (config.dryRun) {
    log(`dry-run skip setMaxTargetAweth(${best.amountOut.toString()})`);
    return;
  }

  const tx = await executor.setMaxTargetAweth(best.amountOut);
  log(`setMaxTargetAweth sent hash=${tx.hash}`);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`setMaxTargetAweth failed hash=${tx.hash}`);
  }
  log(`setMaxTargetAweth confirmed block=${receipt.blockNumber}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
  const wallet = config.privateKey ? new Wallet(config.privateKey).connect(provider) : null;
  const executor = new Contract(config.executorAddress, EXECUTOR_ABI, config.dryRun ? provider : wallet);

  try {
    const owner = getAddress(await executor.owner());
    if (!config.dryRun && !wallet) {
      throw new Error("Missing required env var: OWNER_PRIVATE_KEY");
    }
    if (!config.dryRun && wallet && owner !== getAddress(wallet.address)) {
      throw new Error(`OWNER_PRIVATE_KEY signer ${wallet.address} is not executor owner ${owner}`);
    }

    log(
      [
        "aweth max monitor start",
        `executor=${config.executorAddress}`,
        `owner=${owner}`,
        `poolFee=${config.poolFee}`,
        `intervalMs=${config.intervalMs}`,
        `deviationBps=${config.deviationBps}`,
        `dryRun=${config.dryRun}`
      ].join(" ")
    );

    await runOnce(provider, executor, config);

    if (config.intervalMs === 0) return;

    const timer = setInterval(() => {
      runOnce(provider, executor, config).catch((error) => {
        console.error(`[${timestamp()}] monitor failed:`, error);
      });
    }, config.intervalMs);

    const shutdown = async (signal: string) => {
      log(`shutdown signal=${signal}`);
      clearInterval(timer);
      await provider.destroy();
      process.exit(0);
    };

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  } finally {
    if (config.intervalMs === 0) {
      await provider.destroy();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
