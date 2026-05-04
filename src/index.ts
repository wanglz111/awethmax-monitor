import "dotenv/config";

import { createRequire } from "node:module";
import type { FeeAmount } from "@uniswap/v3-sdk";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  WebSocketProvider,
  Wallet,
  formatEther,
  getAddress,
  isAddress,
  parseEther
} from "ethers";

const require = createRequire(import.meta.url);
const { CurrencyAmount, Token } = require("@uniswap/sdk-core") as typeof import("@uniswap/sdk-core");
const { Pool } = require("@uniswap/v3-sdk") as typeof import("@uniswap/v3-sdk");
const JSBI = require("jsbi") as { BigInt: (value: string) => unknown };

const DEFAULT_RPC_URL = "https://arb1.arbitrum.io/rpc";
const DEFAULT_EXECUTOR_CONTRACT_ADDRESS = "0x860Ad26c581B533016aC62152De040649208508B";
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const AWETH = "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MIN_SQRT_RATIO_PLUS_ONE = 4_295_128_740n;
const SCALE_BPS = 10_000n;
const LOCAL_REFINE_STEP_WEI = 100_000_000_000_000_000n;
const LOCAL_REFINE_WINDOW_WEI = 50_000_000_000_000_000n;
const LOCAL_VERIFY_STEP_WEI = LOCAL_REFINE_STEP_WEI;
const LOCAL_VERIFY_RADIUS_STEPS = 2n;
const DEFAULT_SWAP_POOL_MIN_AWETH_RATIO_BPS = 0;
const WS_RECONNECT_DELAY_MS = 5_000;
const EVENT_TX_DEDUPE_TTL_MS = 60_000;
const LOCAL_TIMEOUT_GRACE_MS = 1_000;

const QUOTER_ABI = [
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
];

const FACTORY_ABI = [
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)"
];

const MULTICALL3_ABI = [
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128,int56 tickCumulativeOutside,uint160 secondsPerLiquidityOutsideX128,uint32 secondsOutside,bool initialized)",
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
  "event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "event Collect(address indexed owner,address recipient,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount0,uint128 amount1)",
  "event Flash(address indexed sender,address indexed recipient,uint256 amount0,uint256 amount1,uint256 paid0,uint256 paid1)"
];

const EXECUTOR_ABI = [
  "function owner() view returns (address)",
  "function maxTargetAweth() view returns (uint256)",
  "function setMaxTargetAweth(uint256 newMaxTargetAweth)",
  "function getSwapPools() view returns (address[] pools,uint24[] fees)",
  "function getSwapPoolMaxTargetAweths() view returns (uint256[] maxTargetAweths)",
  "function getSwapPoolsWithMaxTargetAweths() view returns (address[] pools,uint24[] fees,uint256[] maxTargetAweths)",
  "function setSwapPools(address[] pools,uint24[] fees)",
  "function setSwapPoolsWithMaxTargetAweths(address[] pools,uint24[] fees,uint256[] maxTargetAweths)",
  "function setSwapPoolMaxTargetAweths(uint24[] fees,uint256[] maxTargetAweths)",
  "event ArbitrageExecuted(uint256 flashAmount,uint256 wethSpent,uint256 profit,address indexed caller,address indexed profitRecipient)"
];

type Quote = {
  reason: "profitable-quote" | "no-profitable-quote";
  fee: number;
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

type PoolDecision = {
  fee: number;
  quote: Quote | null;
  keep: boolean;
  reason: "best" | "within-ratio" | "below-ratio" | "no-profitable-quote";
};

type QuoteEvaluation = {
  best: Quote;
  poolDecisions: PoolDecision[];
};

type QuoteRun = {
  evaluation: QuoteEvaluation;
  seeded: boolean;
  source?: string;
};

type Config = {
  quoteRpcUrl: string;
  quoteFallbackRpcUrl: string;
  txRpcUrl: string;
  wsRpcUrl: string | null;
  executorAddress: string;
  poolAddress: string | null;
  privateKey: string | null;
  poolFee: number;
  poolFees: number[];
  maxEth: number;
  lowCoarseMaxEth: number;
  lowCoarseStepEth: number;
  coarseStepEth: number;
  fineStepEth: number;
  fineWindowEth: number;
  concurrency: number;
  quoteBatchSize: number;
  localQuoteEnabled: boolean;
  localQuoteTimeoutMs: number;
  localQuoteShadow: boolean;
  swapPoolMinAwethRatioBps: number;
  eventDebounceMs: number;
  intervalMs: number;
  deviationBps: number;
  deviationAweth: bigint;
  dryRun: boolean;
  barkBaseUrl: string;
  barkDeviceKey: string | null;
  barkTitle: string;
  barkGroup: string;
};

type BarkNotification = {
  title?: string;
  body: string;
};

type WebSocketLikeWithEvents = {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  addEventListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

type ContractListener = {
  contract: Contract;
};

function timestamp(): string {
  return new Date().toISOString();
}

function log(message: string): void {
  console.log(`[${timestamp()}] ${message}`);
}

function elapsedMs(startedAt: number): string {
  return (performance.now() - startedAt).toFixed(1);
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

function parseIntegerList(name: string): number[] {
  const value = optional(name);
  if (!value) return [];

  return value.split(",").map((item) => {
    const parsed = Number.parseInt(item.trim(), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid positive integer list in ${name}: ${value}`);
    }
    return parsed;
  });
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

function parseBps(name: string, fallback: number): number {
  const parsed = parseNonNegativeInteger(name, fallback);
  if (parsed > Number(SCALE_BPS)) {
    throw new Error(`Invalid bps value in ${name}: ${parsed}`);
  }
  return parsed;
}

function parseEtherAmount(name: string, fallback: string): bigint {
  const value = optional(name) ?? fallback;
  try {
    const parsed = parseEther(value);
    if (parsed < 0n) {
      throw new Error("negative");
    }
    return parsed;
  } catch {
    throw new Error(`Invalid ETH amount in ${name}: ${value}`);
  }
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
  const txRpcUrl = optional("TX_RPC_URL") ?? optional("HTTP_RPC_URL") ?? optional("RPC_URL") ?? DEFAULT_RPC_URL;
  const quoteRpcUrl = optional("QUOTE_RPC_URL") ?? DEFAULT_RPC_URL;
  const poolFee = parseInteger("POOL_FEE", 500);
  const poolFees = parseIntegerList("POOL_FEES");

  return {
    quoteRpcUrl,
    quoteFallbackRpcUrl: optional("QUOTE_FALLBACK_RPC_URL") ?? (quoteRpcUrl === txRpcUrl ? quoteRpcUrl : txRpcUrl),
    txRpcUrl,
    wsRpcUrl: optional("WS_RPC_URL"),
    executorAddress: parseAddress("EXECUTOR_CONTRACT_ADDRESS", DEFAULT_EXECUTOR_CONTRACT_ADDRESS),
    poolAddress: optional("POOL_ADDRESS") ? parseAddress("POOL_ADDRESS", ZERO_ADDRESS) : null,
    privateKey: dryRun ? optional("OWNER_PRIVATE_KEY") : required("OWNER_PRIVATE_KEY"),
    poolFee,
    poolFees: poolFees.length > 0 ? poolFees : [poolFee],
    maxEth: parseNumber("MAX_AWETH_SCAN_ETH", 400),
    lowCoarseMaxEth: parseNumber("LOW_COARSE_MAX_ETH", 5),
    lowCoarseStepEth: parseNumber("LOW_COARSE_STEP_ETH", 0.5),
    coarseStepEth: parseNumber("COARSE_STEP_ETH", 5),
    fineStepEth: parseNumber("FINE_STEP_ETH", 0.1),
    fineWindowEth: parseNumber("FINE_WINDOW_ETH", 3),
    concurrency: parseInteger("QUOTE_CONCURRENCY", 6),
    quoteBatchSize: parseInteger("QUOTE_BATCH_SIZE", 80),
    localQuoteEnabled: parseBool("LOCAL_QUOTE_ENABLED", false),
    localQuoteTimeoutMs: parseNonNegativeInteger("LOCAL_QUOTE_TIMEOUT_MS", 120_000),
    localQuoteShadow: parseBool("LOCAL_QUOTE_SHADOW", false),
    swapPoolMinAwethRatioBps: parseBps("SWAP_POOL_MIN_AWETH_RATIO_BPS", DEFAULT_SWAP_POOL_MIN_AWETH_RATIO_BPS),
    eventDebounceMs: parseNonNegativeInteger("EVENT_DEBOUNCE_MS", 2_000),
    intervalMs: parseNonNegativeInteger("MONITOR_INTERVAL_MS", 600_000),
    deviationBps: parseInteger("UPDATE_DEVIATION_BPS", 500),
    deviationAweth: parseEtherAmount("UPDATE_DEVIATION_AWETH", "0.2"),
    dryRun,
    barkBaseUrl: optional("BARK_BASE_URL") ?? "https://api.day.app",
    barkDeviceKey: optional("BARK_DEVICE_KEY"),
    barkTitle: optional("BARK_TITLE") ?? "aWETH Max Monitor",
    barkGroup: optional("BARK_GROUP") ?? "AAVE_ARB"
  };
}

function format(value: bigint): string {
  return Number(formatEther(value)).toFixed(6);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length > 1) {
      url.pathname = `/${parts[0]}/...`;
    } else if (url.pathname.length > 12) {
      url.pathname = "/...";
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.length > 24 ? `${value.slice(0, 24)}...` : value;
  }
}

function range(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end + step / 10; value += step) {
    values.push(Number(value.toFixed(8)));
  }
  return values;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs === 0) return promise;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function withTimeoutNotice<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout: () => void
): Promise<T> {
  if (timeoutMs === 0) return promise;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function overDeviationThreshold(next: bigint, current: bigint, thresholdBps: number, thresholdAweth: bigint): boolean {
  if (current === 0n) return next !== 0n;
  const delta = next > current ? next - current : current - next;
  return delta * SCALE_BPS > current * BigInt(thresholdBps) || delta > thresholdAweth;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function isQuoteRevert(error: unknown): boolean {
  return errorCode(error) === "CALL_EXCEPTION";
}

function fallbackQuote(): Quote {
  return {
    reason: "no-profitable-quote",
    fee: 0,
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

function seedQuoteFromTarget(fee: number, amountOut: bigint): Quote {
  return {
    reason: "profitable-quote",
    fee,
    outEth: amountOutToEthNumber(amountOut),
    amountOut,
    amountIn: 0n,
    maxIn: 0n,
    bufferedProfit: 0n,
    profitBps: 0n,
    sqrtPriceX96After: 0n,
    ticksCrossed: 0,
    gasEstimate: 0
  };
}

function bestQuoteByProfit(quotes: Quote[]): Quote | null {
  return [...quotes].sort((a, b) => (a.bufferedProfit < b.bufferedProfit ? 1 : -1))[0] ?? null;
}

const ARBITRUM_CHAIN_ID = 42_161;
const WETH_TOKEN = new Token(ARBITRUM_CHAIN_ID, WETH, 18, "WETH", "Wrapped Ether");
const AWETH_TOKEN = new Token(ARBITRUM_CHAIN_ID, AWETH, 18, "aWETH", "Aave Arbitrum WETH");
const MAX_UINT_256 = (1n << 256n) - 1n;

function floorDiv(left: number, right: number): number {
  return Math.floor(left / right);
}

function positiveMod(left: number, right: number): number {
  return ((left % right) + right) % right;
}

function mostSignificantBit(value: bigint): number {
  if (value <= 0n) throw new Error("mostSignificantBit requires a positive value");
  return value.toString(2).length - 1;
}

function leastSignificantBit(value: bigint): number {
  if (value <= 0n) throw new Error("leastSignificantBit requires a positive value");
  let bit = 0;
  let cursor = value;
  while ((cursor & 1n) === 0n) {
    cursor >>= 1n;
    bit += 1;
  }
  return bit;
}

class RpcTickDataProvider {
  private readonly bitmapCache = new Map<number, bigint>();
  private readonly tickCache = new Map<number, { liquidityNet: string }>();
  private readonly bitmapInflight = new Map<number, Promise<bigint>>();
  private readonly tickInflight = new Map<number, Promise<{ liquidityNet: string }>>();

  public constructor(
    private readonly pool: Contract,
    private readonly blockTag?: number
  ) {}

  public async getTick(tick: number): Promise<{ liquidityNet: string }> {
    const cached = this.tickCache.get(tick);
    if (cached) return cached;

    const inflight = this.tickInflight.get(tick);
    if (inflight) return inflight;

    const request = this.pool
      .ticks(tick, this.callOverrides())
      .then((result) => {
        const [, liquidityNet] = result;
        const value = { liquidityNet: BigInt(liquidityNet).toString() };
        this.tickCache.set(tick, value);
        return value;
      })
      .finally(() => {
        this.tickInflight.delete(tick);
      });
    this.tickInflight.set(tick, request);
    return request;
  }

  public async nextInitializedTickWithinOneWord(
    tick: number,
    lte: boolean,
    tickSpacing: number
  ): Promise<[number, boolean]> {
    if (lte) {
      const compressed = floorDiv(tick, tickSpacing);
      const wordPosition = compressed >> 8;
      const bitPosition = positiveMod(compressed, 256);
      const mask = (1n << BigInt(bitPosition + 1)) - 1n;
      const masked = (await this.tickBitmap(wordPosition)) & mask;

      if (masked !== 0n) {
        return [(compressed - (bitPosition - mostSignificantBit(masked))) * tickSpacing, true];
      }
      return [(compressed - bitPosition) * tickSpacing, false];
    }

    const compressed = floorDiv(tick, tickSpacing) + 1;
    const wordPosition = compressed >> 8;
    const bitPosition = positiveMod(compressed, 256);
    const mask = MAX_UINT_256 ^ ((1n << BigInt(bitPosition)) - 1n);
    const masked = (await this.tickBitmap(wordPosition)) & mask;

    if (masked !== 0n) {
      return [(compressed + (leastSignificantBit(masked) - bitPosition)) * tickSpacing, true];
    }
    return [(compressed + (255 - bitPosition)) * tickSpacing, false];
  }

  private async tickBitmap(wordPosition: number): Promise<bigint> {
    const cached = this.bitmapCache.get(wordPosition);
    if (cached !== undefined) return cached;

    const inflight = this.bitmapInflight.get(wordPosition);
    if (inflight) return inflight;

    const request = this.pool
      .tickBitmap(wordPosition, this.callOverrides())
      .then((result) => {
        const bitmap = BigInt(result);
        this.bitmapCache.set(wordPosition, bitmap);
        return bitmap;
      })
      .finally(() => {
        this.bitmapInflight.delete(wordPosition);
      });
    this.bitmapInflight.set(wordPosition, request);
    return request;
  }

  private callOverrides(): { blockTag?: number } {
    return this.blockTag === undefined ? {} : { blockTag: this.blockTag };
  }
}

function buildPoolDecisions(config: Config, quotes: Quote[], bestQuote?: Quote): PoolDecision[] {
  const best = bestQuote ?? bestQuoteByProfit(quotes);
  if (!best) {
    return config.poolFees.map((fee) => ({
      fee,
      quote: null,
      keep: false,
      reason: "no-profitable-quote"
    }));
  }

  return config.poolFees.map((fee) => {
    const quote = bestQuoteByProfit(quotes.filter((item) => item.fee === fee));
    if (!quote) {
      return {
        fee,
        quote,
        keep: false,
        reason: "no-profitable-quote"
      };
    }

    if (fee === best.fee) {
      return {
        fee,
        quote,
        keep: true,
        reason: "best"
      };
    }

    const keep =
      config.swapPoolMinAwethRatioBps === 0
      || quote.amountOut * SCALE_BPS >= best.amountOut * BigInt(config.swapPoolMinAwethRatioBps);
    return {
      fee,
      quote,
      keep,
      reason: keep ? "within-ratio" : "below-ratio"
    };
  });
}

class BarkNotifier {
  private readonly endpoint: string;

  public constructor(
    baseUrl: string,
    private readonly deviceKey: string,
    private readonly defaultTitle: string,
    private readonly group: string
  ) {
    this.endpoint = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(deviceKey)}`;
  }

  public async send(notification: BarkNotification): Promise<void> {
    const payload: Record<string, string> = {
      title: notification.title ?? this.defaultTitle,
      body: notification.body,
      group: this.group
    };

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        console.warn(`[bark] HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn("[bark] send failed:", error);
    }
  }
}

function sendNotification(notifier: BarkNotifier | null, notification: BarkNotification): void {
  if (!notifier) return;
  void notifier.send(notification);
}

type QuoteBatch = (fee: number, outEthValues: number[]) => Promise<Array<Quote | null>>;
type QuoteMany = (outEthValues: number[], fees?: number[]) => Promise<Array<Quote | null>>;

function buildQuoteFromInput(
  fee: number,
  outEth: number,
  amountIn: bigint,
  sqrtPriceX96After: bigint,
  ticksCrossed: bigint,
  gasEstimate: bigint
): Quote {
  const amountOut = parseEther(String(outEth));
  return buildQuoteFromRaw(fee, outEth, amountOut, amountIn, sqrtPriceX96After, ticksCrossed, gasEstimate);
}

function buildQuoteFromRaw(
  fee: number,
  outEth: number,
  amountOut: bigint,
  amountIn: bigint,
  sqrtPriceX96After: bigint,
  ticksCrossed: bigint,
  gasEstimate: bigint
): Quote {
  const maxIn = amountIn;
  const bufferedProfit = amountOut - maxIn;

  return {
    reason: "profitable-quote",
    fee,
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
}

function validQuotes(quotes: Array<Quote | null>): Quote[] {
  return quotes
    .filter((item): item is Quote => item !== null)
    .filter((item) => item.sqrtPriceX96After !== MIN_SQRT_RATIO_PLUS_ONE && item.bufferedProfit > 0n)
    .sort((a, b) => (a.bufferedProfit < b.bufferedProfit ? 1 : -1));
}

async function scanBestQuote(config: Config, quoteMany: QuoteMany, quoteBatch: QuoteBatch): Promise<QuoteEvaluation> {
  async function quoteCoarseUntilUnprofitable(outEthValues: number[], fees: number[]): Promise<Quote[]> {
    const feeQuotes = await mapLimit(fees, config.concurrency, async (fee) => {
      const quotes: Quote[] = [];
      for (const values of chunk(outEthValues, config.quoteBatchSize)) {
        const validBatch = validQuotes(await quoteBatch(fee, values));
        if (validBatch.length === 0) {
          break;
        }
        quotes.push(...validBatch);
      }
      return quotes;
    });
    return feeQuotes.flat();
  }

  const lowCoarseEnd = Math.min(config.lowCoarseMaxEth, config.maxEth);
  const lowCoarseQuotes = await quoteMany(range(config.lowCoarseStepEth, lowCoarseEnd, config.lowCoarseStepEth));
  const validLowCoarse = validQuotes(lowCoarseQuotes);

  if (validLowCoarse.length === 0) {
    return {
      best: fallbackQuote(),
      poolDecisions: buildPoolDecisions(config, [])
    };
  }

  const activeFees = [...new Set(validLowCoarse.map((quote) => quote.fee))];
  const highCoarseStart = Math.max(config.coarseStepEth, lowCoarseEnd + config.coarseStepEth);
  const validHighCoarse = await quoteCoarseUntilUnprofitable(
    range(highCoarseStart, config.maxEth, config.coarseStepEth),
    activeFees
  );
  const validCoarse = [...validLowCoarse, ...validHighCoarse].sort((a, b) =>
    a.bufferedProfit < b.bufferedProfit ? 1 : -1
  );

  if (validCoarse.length === 0) {
    return {
      best: fallbackQuote(),
      poolDecisions: buildPoolDecisions(config, [])
    };
  }

  const fineCenters = [...new Set(validCoarse.map((quote) => quote.fee))]
    .map((fee) => bestQuoteByProfit(validCoarse.filter((quote) => quote.fee === fee)))
    .filter((quote): quote is Quote => quote !== null);
  const fineQuoteGroups = await mapLimit(fineCenters, config.concurrency, (quote) => {
    const fineStart = Math.max(config.fineStepEth, quote.outEth - config.fineWindowEth);
    const fineEnd = Math.min(config.maxEth, quote.outEth + config.fineWindowEth);
    return quoteMany(range(fineStart, fineEnd, config.fineStepEth), [quote.fee]);
  });
  const validFine = validQuotes(fineQuoteGroups.flat());

  const validQuotesForDecision = [...validCoarse, ...validFine];
  const best = bestQuoteByProfit(validQuotesForDecision) ?? validCoarse[0];

  return {
    best,
    poolDecisions: buildPoolDecisions(config, validQuotesForDecision, best)
  };
}

async function scanSeededBestQuote(
  config: Config,
  quoteMany: QuoteMany,
  seedEvaluation: QuoteEvaluation
): Promise<QuoteEvaluation | null> {
  const centers = seedEvaluation.poolDecisions
    .map((decision) => decision.quote)
    .filter((quote): quote is Quote => quote !== null);

  if (centers.length === 0) return null;

  const seededStepEth = Math.max(config.fineStepEth, config.fineWindowEth / 15);
  const quoteGroups = await mapLimit(centers, config.concurrency, (quote) => {
    const fineStart = Math.max(seededStepEth, quote.outEth - config.fineWindowEth);
    const fineEnd = Math.min(config.maxEth, quote.outEth + config.fineWindowEth);
    return quoteMany(range(fineStart, fineEnd, seededStepEth), [quote.fee]);
  });
  const quotes = validQuotes(quoteGroups.flat());
  const best = bestQuoteByProfit(quotes);

  if (!best) return null;

  const centerByFee = new Map(centers.map((quote) => [quote.fee, quote]));
  const edgeHit = config.poolFees.some((fee) => {
    const center = centerByFee.get(fee);
    const quote = bestQuoteByProfit(quotes.filter((item) => item.fee === fee));
    if (!center || !quote) return false;

    const fineStart = Math.max(seededStepEth, center.outEth - config.fineWindowEth);
    const fineEnd = Math.min(config.maxEth, center.outEth + config.fineWindowEth);
    return quote.outEth <= fineStart + seededStepEth / 10 || quote.outEth >= fineEnd - seededStepEth / 10;
  });

  if (edgeHit) return null;

  return {
    best,
    poolDecisions: buildPoolDecisions(config, quotes, best)
  };
}

type LocalQuoteContext = {
  fee: number;
  pool: typeof Pool.prototype;
};

function amountOutToEthNumber(amountOut: bigint): number {
  return Number(formatEther(amountOut));
}

function quoteParamsRaw(fee: number, amountOut: bigint) {
  return {
    tokenIn: WETH,
    tokenOut: AWETH,
    amount: amountOut,
    fee,
    sqrtPriceLimitX96: MIN_SQRT_RATIO_PLUS_ONE
  };
}

async function buildLocalQuoteContexts(
  provider: JsonRpcProvider,
  fallbackProvider: JsonRpcProvider | null,
  config: Config,
  blockTag: number
): Promise<Map<number, LocalQuoteContext>> {
  const entries = await Promise.all(
    config.poolFees.map(async (fee) => {
      const poolAddress = await resolvePoolAddressForFee(provider, fallbackProvider, config, fee);
      const poolContract = new Contract(poolAddress, POOL_ABI, provider);
      const overrides = { blockTag };
      const [slot0, liquidity] = await Promise.all([
        poolContract.slot0(overrides),
        poolContract.liquidity(overrides)
      ]);
      const tickDataProvider = new RpcTickDataProvider(poolContract, blockTag);
      const pool = new Pool(
        WETH_TOKEN,
        AWETH_TOKEN,
        fee as FeeAmount,
        BigInt(slot0.sqrtPriceX96).toString(),
        BigInt(liquidity).toString(),
        Number(slot0.tick),
        tickDataProvider
      );
      return [fee, { fee, pool }] as const;
    })
  );
  return new Map(entries);
}

function localVerificationAmountOuts(center: bigint, maxAmountOut: bigint): bigint[] {
  const values: bigint[] = [];
  for (let offset = -LOCAL_VERIFY_RADIUS_STEPS; offset <= LOCAL_VERIFY_RADIUS_STEPS; offset += 1n) {
    const amountOut = center + offset * LOCAL_VERIFY_STEP_WEI;
    if (amountOut > 0n && amountOut <= maxAmountOut) {
      values.push(amountOut);
    }
  }
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : 1));
}

async function verifyLocalEvaluationWithEthCall(
  provider: JsonRpcProvider,
  config: Config,
  evaluation: QuoteEvaluation,
  blockTag: number
): Promise<QuoteEvaluation> {
  const quoter = new Contract(QUOTER_V2, QUOTER_ABI, provider);
  const multicall = new Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const quoterInterface = new Interface(QUOTER_ABI);
  const maxAmountOut = parseEther(String(config.maxEth));
  const candidates = evaluation.poolDecisions
    .map((decision) => decision.quote)
    .filter((quote): quote is Quote => quote !== null)
    .flatMap((quote) =>
      localVerificationAmountOuts(quote.amountOut, maxAmountOut).map((amountOut) => ({ fee: quote.fee, amountOut }))
    );
  const uniqueCandidates = [...new Map(candidates.map((item) => [`${item.fee}:${item.amountOut}`, item])).values()];

  if (uniqueCandidates.length === 0) {
    return {
      best: fallbackQuote(),
      poolDecisions: buildPoolDecisions(config, [])
    };
  }

  function buildQuote(fee: number, amountOut: bigint, returnData: string): Quote | null {
    try {
      const [amountIn, sqrtPriceX96After, ticksCrossed, gasEstimate] =
        quoterInterface.decodeFunctionResult("quoteExactOutputSingle", returnData);
      return buildQuoteFromRaw(
        fee,
        amountOutToEthNumber(amountOut),
        amountOut,
        amountIn,
        sqrtPriceX96After,
        ticksCrossed,
        gasEstimate
      );
    } catch {
      return null;
    }
  }

  async function quoteSingle(fee: number, amountOut: bigint): Promise<Quote | null> {
    try {
      const [amountIn, sqrtPriceX96After, ticksCrossed, gasEstimate] =
        await quoter.quoteExactOutputSingle.staticCall(quoteParamsRaw(fee, amountOut), { blockTag });
      return buildQuoteFromRaw(
        fee,
        amountOutToEthNumber(amountOut),
        amountOut,
        amountIn,
        sqrtPriceX96After,
        ticksCrossed,
        gasEstimate
      );
    } catch (error) {
      if (!isQuoteRevert(error)) throw error;
      return null;
    }
  }

  const calls = uniqueCandidates.map(({ fee, amountOut }) => ({
    target: QUOTER_V2,
    allowFailure: true,
    callData: quoterInterface.encodeFunctionData("quoteExactOutputSingle", [quoteParamsRaw(fee, amountOut)])
  }));

  let quotes: Array<Quote | null>;
  try {
    const results = await multicall.aggregate3.staticCall(calls, { blockTag });
    quotes = results.map((result: { success: boolean; returnData: string }, index: number) => {
      if (!result.success) return null;
      const candidate = uniqueCandidates[index];
      return buildQuote(candidate.fee, candidate.amountOut, result.returnData);
    });
  } catch {
    quotes = await mapLimit(uniqueCandidates, config.concurrency, (candidate) =>
      quoteSingle(candidate.fee, candidate.amountOut)
    );
  }

  const verifiedQuotes = validQuotes(quotes);
  const best = bestQuoteByProfit(verifiedQuotes);
  return {
    best: best ?? fallbackQuote(),
    poolDecisions: buildPoolDecisions(config, verifiedQuotes, best ?? undefined)
  };
}

async function refineLocalQuote(
  config: Config,
  center: Quote,
  localQuoteRaw: (fee: number, amountOut: bigint) => Promise<Quote | null>,
  windowWei = LOCAL_REFINE_WINDOW_WEI
): Promise<Quote | null> {
  const maxIndex = parseEther(String(config.maxEth)) / LOCAL_REFINE_STEP_WEI;
  const centerIndex = center.amountOut / LOCAL_REFINE_STEP_WEI;
  const windowSteps = windowWei / LOCAL_REFINE_STEP_WEI;
  let low = centerIndex > windowSteps ? centerIndex - windowSteps : 1n;
  let high = centerIndex + windowSteps < maxIndex ? centerIndex + windowSteps : maxIndex;
  const cache = new Map<string, Quote | null>();

  async function quoteAt(index: bigint): Promise<Quote | null> {
    const key = index.toString();
    if (cache.has(key)) return cache.get(key) ?? null;
    const quote = await localQuoteRaw(center.fee, index * LOCAL_REFINE_STEP_WEI);
    cache.set(key, quote);
    return quote;
  }

  async function profitAt(index: bigint): Promise<bigint> {
    const quote = await quoteAt(index);
    return quote && quote.sqrtPriceX96After !== MIN_SQRT_RATIO_PLUS_ONE ? quote.bufferedProfit : -1n;
  }

  while (high - low > 6n) {
    const third = (high - low) / 3n;
    const midLeft = low + third;
    const midRight = high - third;
    const [leftProfit, rightProfit] = await Promise.all([profitAt(midLeft), profitAt(midRight)]);
    if (leftProfit < rightProfit) {
      low = midLeft + 1n;
    } else {
      high = midRight - 1n;
    }
  }

  const candidates: Quote[] = [];
  for (let index = low; index <= high; index += 1n) {
    const quote = await quoteAt(index);
    if (quote) candidates.push(quote);
  }
  return bestQuoteByProfit(validQuotes(candidates));
}

async function findBestLocalVerifiedQuote(
  provider: JsonRpcProvider,
  fallbackProvider: JsonRpcProvider | null,
  config: Config,
  seedEvaluation: QuoteEvaluation | null = null
): Promise<QuoteRun> {
  const startedAt = performance.now();
  const ethCallStartedAt = performance.now();
  const baseRun = await findBestEthCallQuote(provider, config, seedEvaluation);
  log(
    `hybrid eth_call center scan completed seeded=${baseRun.seeded} elapsedMs=${elapsedMs(ethCallStartedAt)}`
  );

  if (!config.localQuoteEnabled) {
    log("hybrid local refine/verify disabled; using eth_call center scan result");
    return {
      evaluation: baseRun.evaluation,
      seeded: baseRun.seeded,
      source: "hybrid_eth_call_center"
    };
  }

  const blockTag = await provider.getBlockNumber();
  log(`hybrid local refine block pinned block=${blockTag}`);
  const contexts = await buildLocalQuoteContexts(provider, fallbackProvider, config, blockTag);
  log(`hybrid local contexts ready block=${blockTag} elapsedMs=${elapsedMs(startedAt)}`);
  const sqrtPriceLimitX96 = JSBI.BigInt(MIN_SQRT_RATIO_PLUS_ONE.toString());
  let localTimedOut = false;

  async function localQuoteRaw(fee: number, amountOut: bigint): Promise<Quote | null> {
    if (localTimedOut) {
      throw new Error("hybrid local refine/verify stopped after timeout");
    }

    const context = contexts.get(fee);
    if (!context) return null;

    try {
      const output = CurrencyAmount.fromRawAmount(AWETH_TOKEN, amountOut.toString());
      const [input, nextPool] = await context.pool.getInputAmount(output, sqrtPriceLimitX96 as never);
      return buildQuoteFromRaw(
        fee,
        amountOutToEthNumber(amountOut),
        amountOut,
        BigInt(input.quotient.toString()),
        BigInt(nextPool.sqrtRatioX96.toString()),
        0n,
        0n
      );
    } catch {
      return null;
    }
  }

  async function refineAndVerify(): Promise<QuoteEvaluation> {
    const refineStartedAt = performance.now();
    const refinedQuotes = (
      await mapLimit(
        baseRun.evaluation.poolDecisions
          .map((decision) => decision.quote)
          .filter((quote): quote is Quote => quote !== null),
        config.concurrency,
        async (quote) => refineLocalQuote(config, quote, localQuoteRaw)
      )
    ).filter((quote): quote is Quote => quote !== null);
    log(`hybrid local refine completed block=${blockTag} elapsedMs=${elapsedMs(refineStartedAt)}`);
    const refinedBest = bestQuoteByProfit(refinedQuotes);
    if (!refinedBest) {
      throw new Error("hybrid local refine produced no profitable quotes");
    }
    const refinedEvaluation = {
      best: refinedBest,
      poolDecisions: buildPoolDecisions(config, refinedQuotes, refinedBest)
    };
    const verifyStartedAt = performance.now();
    const verifiedEvaluation = await verifyLocalEvaluationWithEthCall(provider, config, refinedEvaluation, blockTag);
    log(
      `hybrid local quote verified block=${blockTag} verifyMs=${elapsedMs(verifyStartedAt)} totalMs=${elapsedMs(
        startedAt
      )}`
    );
    return verifiedEvaluation;
  }

  const localTimeoutMs = config.localQuoteTimeoutMs;
  let verifiedEvaluation: QuoteEvaluation;
  let source = "hybrid_local_verified";
  try {
    log(
      `hybrid local refine/verify starting block=${blockTag} timeoutMs=${
        localTimeoutMs === 0 ? "disabled" : localTimeoutMs
      }`
    );
    verifiedEvaluation = await withTimeoutNotice(
      refineAndVerify(),
      localTimeoutMs,
      "hybrid local refine/verify",
      () => {
        localTimedOut = true;
      }
    );
  } catch (error) {
    console.warn(
      `[${timestamp()}] hybrid local refine/verify failed; using eth_call center scan result:`,
      error
    );
    verifiedEvaluation = baseRun.evaluation;
    source = "hybrid_eth_call_center";
  }

  return {
    evaluation: verifiedEvaluation,
    seeded: baseRun.seeded,
    source
  };
}

async function findBestEthCallQuote(
  provider: JsonRpcProvider,
  config: Config,
  seedEvaluation: QuoteEvaluation | null = null
): Promise<QuoteRun> {
  const multicall = new Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const quoter = new Contract(QUOTER_V2, QUOTER_ABI, provider);
  const quoterInterface = new Interface(QUOTER_ABI);

  function buildQuote(fee: number, outEth: number, returnData: string): Quote | null {
    try {
      const [amountIn, sqrtPriceX96After, ticksCrossed, gasEstimate] =
        quoterInterface.decodeFunctionResult("quoteExactOutputSingle", returnData);
      return buildQuoteFromInput(fee, outEth, amountIn, sqrtPriceX96After, ticksCrossed, gasEstimate);
    } catch {
      return null;
    }
  }

  function quoteParams(fee: number, outEth: number) {
    return {
      tokenIn: WETH,
      tokenOut: AWETH,
      amount: parseEther(String(outEth)),
      fee,
      sqrtPriceLimitX96: MIN_SQRT_RATIO_PLUS_ONE
    };
  }

  async function quoteSingle(fee: number, outEth: number): Promise<Quote | null> {
    try {
      const [amountIn, sqrtPriceX96After, ticksCrossed, gasEstimate] =
        await quoter.quoteExactOutputSingle.staticCall(quoteParams(fee, outEth));
      return buildQuoteFromInput(fee, outEth, amountIn, sqrtPriceX96After, ticksCrossed, gasEstimate);
    } catch (error) {
      if (!isQuoteRevert(error)) throw error;
      return null;
    }
  }

  async function quoteSingles(fee: number, outEthValues: number[]): Promise<Array<Quote | null>> {
    const quotes: Array<Quote | null> = [];
    for (const outEth of outEthValues) {
      quotes.push(await quoteSingle(fee, outEth));
    }
    return quotes;
  }

  async function quoteBatch(fee: number, outEthValues: number[]): Promise<Array<Quote | null>> {
    if (outEthValues.length === 1) {
      return quoteSingles(fee, outEthValues);
    }

    const calls = outEthValues.map((outEth) => ({
      target: QUOTER_V2,
      allowFailure: true,
      callData: quoterInterface.encodeFunctionData("quoteExactOutputSingle", [quoteParams(fee, outEth)])
    }));

    try {
      const results = await multicall.aggregate3.staticCall(calls);
      return results.map((result: { success: boolean; returnData: string }, index: number) => {
        if (!result.success) return null;
        return buildQuote(fee, outEthValues[index], result.returnData);
      });
    } catch (error) {
      if (outEthValues.length <= 2) {
        return quoteSingles(fee, outEthValues);
      }
      const midpoint = Math.ceil(outEthValues.length / 2);
      const [left, right] = await Promise.all([
        quoteBatch(fee, outEthValues.slice(0, midpoint)),
        quoteBatch(fee, outEthValues.slice(midpoint))
      ]);
      return [...left, ...right];
    }
  }

  async function quoteMany(outEthValues: number[], fees = config.poolFees): Promise<Array<Quote | null>> {
    const batches = fees.flatMap((fee) =>
      chunk(outEthValues, config.quoteBatchSize).map((values) => ({ fee, values }))
    );
    const batchQuotes = await mapLimit(batches, config.concurrency, (batch) => quoteBatch(batch.fee, batch.values));
    return batchQuotes.flat();
  }

  if (seedEvaluation) {
    const seededEvaluation = await scanSeededBestQuote(config, quoteMany, seedEvaluation);
    if (seededEvaluation) {
      return {
        evaluation: seededEvaluation,
        seeded: true
      };
    }
    log("seeded scan fell back to full scan");
  }

  return {
    evaluation: await scanBestQuote(config, quoteMany, quoteBatch),
    seeded: false
  };
}

async function compareLocalQuoteShadow(
  provider: JsonRpcProvider,
  fallbackProvider: JsonRpcProvider | null,
  config: Config,
  quote: Quote
): Promise<void> {
  const startedAt = performance.now();
  try {
    if (quote.reason !== "profitable-quote" || quote.fee === 0) return;

    const storageStartedAt = performance.now();
    const poolAddress = await resolvePoolAddressForFee(provider, fallbackProvider, config, quote.fee);
    const poolContract = new Contract(poolAddress, POOL_ABI, provider);
    const [slot0, liquidity] = await Promise.all([poolContract.slot0(), poolContract.liquidity()]);
    const storageMs = elapsedMs(storageStartedAt);

    const localComputeStartedAt = performance.now();
    const tickDataProvider = new RpcTickDataProvider(poolContract);
    const pool = new Pool(
      WETH_TOKEN,
      AWETH_TOKEN,
      quote.fee as FeeAmount,
      BigInt(slot0.sqrtPriceX96).toString(),
      BigInt(liquidity).toString(),
      Number(slot0.tick),
      tickDataProvider
    );
    const output = CurrencyAmount.fromRawAmount(AWETH_TOKEN, quote.amountOut.toString());
    const [input] = await pool.getInputAmount(
      output,
      JSBI.BigInt(MIN_SQRT_RATIO_PLUS_ONE.toString()) as never
    );
    const localAmountIn = BigInt(input.quotient.toString());
    const localMaxIn = localAmountIn;
    const localBufferedProfit = quote.amountOut - localMaxIn;
    const amountInDiff = localAmountIn - quote.amountIn;
    const bufferedProfitDiff = localBufferedProfit - quote.bufferedProfit;
    const localComputeMs = elapsedMs(localComputeStartedAt);

    log(
      [
        "localQuoteShadow",
        `totalMs=${elapsedMs(startedAt)}`,
        `storageMs=${storageMs}`,
        `localComputeMs=${localComputeMs}`,
        `fee=${quote.fee}`,
        `target=${format(quote.amountOut)}aWETH`,
        `rpcAmountIn=${format(quote.amountIn)}WETH`,
        `localAmountIn=${format(localAmountIn)}WETH`,
        `amountInDiffWei=${amountInDiff.toString()}`,
        `rpcProfit=${format(quote.bufferedProfit)}WETH`,
        `localProfit=${format(localBufferedProfit)}WETH`,
        `profitDiffWei=${bufferedProfitDiff.toString()}`
      ].join(" ")
    );
  } catch (error) {
    console.warn(`[${timestamp()}] localQuoteShadow failed:`, error);
  }
}

function sameFeeList(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((fee, index) => fee === right[index]);
}

function sameAddressList(left: string[], right: string[]): boolean {
  return (
    left.length === right.length
    && left.every((address, index) => getAddress(address) === getAddress(right[index] ?? ZERO_ADDRESS))
  );
}

function targetChangedIndexes(left: bigint[], right: bigint[], thresholdBps: number, thresholdAweth: bigint): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < left.length; index += 1) {
    if (overDeviationThreshold(left[index], right[index] ?? 0n, thresholdBps, thresholdAweth)) {
      indexes.push(index);
    }
  }
  return indexes;
}

function targetAmountForDecision(decision: PoolDecision): bigint {
  return decision.quote?.amountOut ?? 1n;
}

function formatPoolDecisions(decisions: PoolDecision[]): string {
  return decisions
    .map((decision) => {
      const aweth = decision.quote ? format(decision.quote.amountOut) : "0.000000";
      const profit = decision.quote ? format(decision.quote.bufferedProfit) : "0.000000";
      return `${decision.fee}:${decision.keep ? "keep" : "remove"}:${decision.reason}:aweth=${aweth}:bufferedProfit=${profit}`;
    })
    .join(",");
}

function formatPoolCapsForNotification(decisions: PoolDecision[]): string {
  const caps = decisions
    .filter((decision) => targetAmountForDecision(decision) !== 1n)
    .map((decision) => `${decision.fee}: ${format(targetAmountForDecision(decision))} aWETH`);
  return caps.length > 0 ? caps.join("\n") : "none";
}

function totalBufferedProfit(decisions: PoolDecision[]): bigint {
  return decisions.reduce((total, decision) => total + (decision.quote?.bufferedProfit ?? 0n), 0n);
}

function eventFee(reason: string): number | null {
  const match = /^pool-(\d+)-/.exec(reason);
  return match ? Number(match[1]) : null;
}

function logEvaluation(source: string, evaluation: QuoteEvaluation, config: Config): void {
  const { best, poolDecisions } = evaluation;
  log(
    [
      `quoteSource=${source}`,
      `recommended=${format(best.amountOut)}aWETH`,
      `fee=${best.fee}`,
      `reason=${best.reason}`,
      `thresholdBps=${config.deviationBps}`,
      `thresholdAweth=${format(config.deviationAweth)}`,
      `bufferedProfit=${format(best.bufferedProfit)}WETH`,
      `profitBps=${best.profitBps.toString()}`,
      `ticks=${best.ticksCrossed}`,
      `quoteGas=${best.gasEstimate}`,
      `poolDecisions=${formatPoolDecisions(poolDecisions)}`
    ].join(" ")
  );
}

function sendCapsUpdatedNotification(
  notifier: BarkNotifier | null,
  evaluation: QuoteEvaluation,
  titleSuffix = ""
): void {
  const { best, poolDecisions } = evaluation;
  sendNotification(notifier, {
    title: `aWETH Pool Caps Updated${titleSuffix}`,
    body: [
      `Best fee: ${best.fee}`,
      `Best cap: ${format(best.amountOut)} aWETH`,
      `Reason: ${best.reason}`,
      `Max profit: ${format(totalBufferedProfit(poolDecisions))} WETH`,
      "Pool caps:",
      formatPoolCapsForNotification(poolDecisions)
    ].join("\n")
  });
}

async function resolveSwapPoolAddressForFee(
  quoteProvider: JsonRpcProvider,
  quoteFallbackProvider: JsonRpcProvider | null,
  config: Config,
  fee: number
): Promise<string> {
  if (config.poolAddress && config.poolFees.length === 1) {
    return config.poolAddress;
  }
  return resolvePoolAddressForFee(quoteProvider, quoteFallbackProvider, config, fee);
}

async function syncSwapPools(
  quoteProvider: JsonRpcProvider,
  quoteFallbackProvider: JsonRpcProvider | null,
  executor: Contract,
  config: Config,
  decisions: PoolDecision[]
): Promise<boolean> {
  const targetFees = config.poolFees;
  const targetMaxTargetAweths = targetFees.map((fee) => {
    const decision = decisions.find((item) => item.fee === fee);
    return decision ? targetAmountForDecision(decision) : 1n;
  });
  const targetPools = await Promise.all(
    targetFees.map((fee) => resolveSwapPoolAddressForFee(quoteProvider, quoteFallbackProvider, config, fee))
  );

  const [currentPoolsRaw, currentFeesRaw] = await executor.getSwapPools();
  const currentPools = Array.from(currentPoolsRaw as Iterable<string>).map((pool) => getAddress(pool));
  const currentFees = Array.from(currentFeesRaw as Iterable<bigint | number>).map((fee) => Number(fee));

  let currentMaxTargetAweths: bigint[];
  try {
    const currentTargetsRaw = await executor.getSwapPoolMaxTargetAweths();
    currentMaxTargetAweths = Array.from(currentTargetsRaw as Iterable<bigint | number>).map((target) =>
      BigInt(target)
    );
  } catch {
    const legacyGlobalTarget = BigInt(await executor.maxTargetAweth());
    currentMaxTargetAweths = currentFees.map(() => legacyGlobalTarget);
  }

  const feeListChanged = !sameFeeList(currentFees, targetFees);
  const poolListChanged = !sameAddressList(currentPools, targetPools);
  const changedIndexes = targetChangedIndexes(
    targetMaxTargetAweths,
    currentMaxTargetAweths,
    config.deviationBps,
    config.deviationAweth
  );

  if (!feeListChanged && !poolListChanged && changedIndexes.length === 0) {
    log(
      `swapPools unchanged fees=${targetFees.join(",")} targets=[${targetMaxTargetAweths
        .map((target) => format(target))
        .join(",")}]`
    );
    return false;
  }

  if (feeListChanged || poolListChanged) {
    if (config.dryRun) {
      log(
        `dry-run skip setSwapPoolsWithMaxTargetAweths(pools=[${targetPools.join(",")}], fees=[${targetFees.join(
          ","
        )}], targets=[${targetMaxTargetAweths.map((target) => target.toString()).join(",")}])`
      );
      return false;
    }

    const tx = await executor.setSwapPoolsWithMaxTargetAweths(targetPools, targetFees, targetMaxTargetAweths);
    log(
      `setSwapPoolsWithMaxTargetAweths sent hash=${tx.hash} fees=${targetFees.join(",")} targets=[${targetMaxTargetAweths
        .map((target) => format(target))
        .join(",")}]`
    );
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`setSwapPoolsWithMaxTargetAweths failed hash=${tx.hash}`);
    }
    log(`setSwapPoolsWithMaxTargetAweths confirmed block=${receipt.blockNumber} fees=${targetFees.join(",")}`);
    return true;
  }

  const changedFees = changedIndexes.map((index) => targetFees[index]);
  const changedTargets = changedIndexes.map((index) => targetMaxTargetAweths[index]);
  if (config.dryRun) {
    log(
      `dry-run skip setSwapPoolMaxTargetAweths(fees=[${changedFees.join(",")}], targets=[${changedTargets
        .map((target) => target.toString())
        .join(",")}])`
    );
    return false;
  }

  const tx = await executor.setSwapPoolMaxTargetAweths(changedFees, changedTargets);
  log(
    `setSwapPoolMaxTargetAweths sent hash=${tx.hash} fees=${changedFees.join(",")} targets=[${changedTargets
      .map((target) => format(target))
      .join(",")}]`
  );
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`setSwapPoolMaxTargetAweths failed hash=${tx.hash}`);
  }
  log(`setSwapPoolMaxTargetAweths confirmed block=${receipt.blockNumber} fees=${changedFees.join(",")}`);
  return true;
}

async function startupSeedEvaluationFromExecutor(executor: Contract, config: Config): Promise<QuoteEvaluation | null> {
  let currentFees: number[];
  let currentMaxTargetAweths: bigint[];

  try {
    const [, feesRaw, targetsRaw] = await executor.getSwapPoolsWithMaxTargetAweths();
    currentFees = Array.from(feesRaw as Iterable<bigint | number>).map((fee) => Number(fee));
    currentMaxTargetAweths = Array.from(targetsRaw as Iterable<bigint | number>).map((target) => BigInt(target));
  } catch {
    const [, feesRaw] = await executor.getSwapPools();
    currentFees = Array.from(feesRaw as Iterable<bigint | number>).map((fee) => Number(fee));

    try {
      const targetsRaw = await executor.getSwapPoolMaxTargetAweths();
      currentMaxTargetAweths = Array.from(targetsRaw as Iterable<bigint | number>).map((target) => BigInt(target));
    } catch {
      const legacyGlobalTarget = BigInt(await executor.maxTargetAweth());
      currentMaxTargetAweths = currentFees.map(() => legacyGlobalTarget);
    }
  }

  const maxAmountOut = parseEther(String(config.maxEth));
  const quoteByFee = new Map<number, Quote>();
  for (let index = 0; index < currentFees.length; index += 1) {
    const fee = currentFees[index];
    const amountOut = currentMaxTargetAweths[index] ?? 0n;
    if (!config.poolFees.includes(fee) || amountOut <= 1n || amountOut > maxAmountOut) {
      continue;
    }
    quoteByFee.set(fee, seedQuoteFromTarget(fee, amountOut));
  }

  const quotes = config.poolFees.map((fee) => quoteByFee.get(fee)).filter((quote): quote is Quote => quote !== undefined);
  if (quotes.length === 0) {
    log("startup seeded scan disabled currentTargets=none");
    return null;
  }

  log(
    `startup seeded scan enabled targets=[${quotes.map((quote) => `${quote.fee}:${format(quote.amountOut)}`).join(",")}]`
  );
  const best = [...quotes].sort((a, b) => (a.amountOut < b.amountOut ? 1 : -1))[0];
  return {
    best,
    poolDecisions: config.poolFees.map((fee) => {
      const quote = quoteByFee.get(fee) ?? null;
      return {
        fee,
        quote,
        keep: quote !== null,
        reason: quote ? "within-ratio" : "no-profitable-quote"
      };
    })
  };
}

async function runOnce(
  quoteProvider: JsonRpcProvider,
  quoteFallbackProvider: JsonRpcProvider | null,
  executor: Contract,
  config: Config,
  notifier: BarkNotifier | null,
  seedEvaluation: QuoteEvaluation | null
): Promise<QuoteEvaluation> {
  let evaluation: QuoteEvaluation;
  let seeded = false;
  let evaluationProvider = quoteProvider;
  let quoteSource = "hybrid_local_verified";
  try {
    const result = await withTimeout(
      findBestLocalVerifiedQuote(quoteProvider, quoteFallbackProvider, config, seedEvaluation),
      config.localQuoteTimeoutMs === 0 ? 0 : config.localQuoteTimeoutMs * 2 + LOCAL_TIMEOUT_GRACE_MS,
      "hybrid local verified quote"
    );
    evaluation = result.evaluation;
    seeded = result.seeded;
    quoteSource = result.source ?? quoteSource;
  } catch (error) {
    console.warn(`[${timestamp()}] hybrid local verified quote failed; falling back to eth_call scan:`, error);
    try {
      const result = await findBestEthCallQuote(quoteProvider, config, seedEvaluation);
      evaluation = result.evaluation;
      seeded = result.seeded;
      quoteSource = "eth_call_fallback";
    } catch (fallbackError) {
      if (!quoteFallbackProvider) throw fallbackError;
      evaluationProvider = quoteFallbackProvider;
      const result = await findBestEthCallQuote(quoteFallbackProvider, config, seedEvaluation);
      evaluation = result.evaluation;
      seeded = result.seeded;
      quoteSource = "eth_call_fallback";
    }
  }

  logEvaluation(seeded ? `${quoteSource}_seeded` : quoteSource, evaluation, config);

  if (config.localQuoteShadow) {
    void compareLocalQuoteShadow(evaluationProvider, quoteFallbackProvider, config, evaluation.best);
  }

  await syncSwapPools(quoteProvider, quoteFallbackProvider, executor, config, evaluation.poolDecisions);
  return evaluation;
}

class EvaluationRunner {
  private inFlight = false;
  private queuedReason: string | null = null;
  private queuedEventFees = new Set<number>();
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEventReason: string | null = null;
  private pendingEventFees = new Set<number>();
  private lastEvaluation: QuoteEvaluation | null = null;
  private readonly seenEventTxs = new Map<string, number>();

  public constructor(
    private readonly quoteProvider: JsonRpcProvider,
    private readonly quoteFallbackProvider: JsonRpcProvider | null,
    private readonly executor: Contract,
    private readonly config: Config,
    private readonly notifier: BarkNotifier | null
  ) {}

  public trigger(reason: string, eventFees = new Set<number>()): void {
    if (this.inFlight) {
      this.queuedReason = reason;
      for (const fee of eventFees) {
        this.queuedEventFees.add(fee);
      }
      log(`evaluation queued reason=${reason}`);
      return;
    }

    this.inFlight = true;
    void this.runLoop(reason, eventFees);
  }

  public triggerEvent(reason: string, txHash: string | null): void {
    this.pruneSeenEventTxs();
    if (txHash && txHash !== "unknown") {
      if (this.seenEventTxs.has(txHash)) {
        log(`event ignored duplicate tx=${txHash} reason=${reason}`);
        return;
      }
      this.seenEventTxs.set(txHash, Date.now() + EVENT_TX_DEDUPE_TTL_MS);
    }

    const fee = eventFee(reason);
    if (fee !== null) {
      this.pendingEventFees.add(fee);
    }

    this.pendingEventReason = this.pendingEventReason ? "event-batch" : reason;
    if (this.config.eventDebounceMs === 0) {
      const nextReason = this.pendingEventReason;
      const nextEventFees = this.pendingEventFees;
      this.pendingEventReason = null;
      this.pendingEventFees = new Set();
      this.trigger(nextReason, nextEventFees);
      return;
    }

    if (this.eventTimer) {
      log(`event debounced reason=${reason}`);
      return;
    }

    log(`event scheduled reason=${reason} debounceMs=${this.config.eventDebounceMs}`);
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null;
      const nextReason = this.pendingEventReason ?? reason;
      const nextEventFees = this.pendingEventFees;
      this.pendingEventReason = null;
      this.pendingEventFees = new Set();
      this.trigger(nextReason, nextEventFees);
    }, this.config.eventDebounceMs);
  }

  private pruneSeenEventTxs(): void {
    const now = Date.now();
    for (const [txHash, expiresAt] of this.seenEventTxs) {
      if (expiresAt <= now) {
        this.seenEventTxs.delete(txHash);
      }
    }
  }

  private async seedEvaluationFor(reason: string, eventFees: Set<number>): Promise<QuoteEvaluation | null> {
    if (reason === "startup" && !this.lastEvaluation) {
      return startupSeedEvaluationFromExecutor(this.executor, this.config);
    }

    if (reason === "interval" || !this.lastEvaluation) {
      return null;
    }

    for (const fee of eventFees) {
      const decision = this.lastEvaluation.poolDecisions.find((item) => item.fee === fee);
      if (!decision?.quote) {
        log(`seeded scan disabled reason=${reason} fee=${fee} previousQuote=none`);
        return null;
      }
    }

    return this.lastEvaluation;
  }

  private async runLoop(initialReason: string, initialEventFees: Set<number>): Promise<void> {
    let reason: string | null = initialReason;
    let eventFees = initialEventFees;
    while (reason) {
      log(`evaluation start reason=${reason}`);
      try {
        const seedEvaluation = await this.seedEvaluationFor(reason, eventFees);
        this.lastEvaluation = await runOnce(
          this.quoteProvider,
          this.quoteFallbackProvider,
          this.executor,
          this.config,
          this.notifier,
          seedEvaluation
        );
      } catch (error) {
        console.error(`[${timestamp()}] evaluation failed reason=${reason}:`, error);
        sendNotification(this.notifier, {
          title: "aWETH Monitor Failed",
          body: [`Reason: ${reason}`, `Error: ${error instanceof Error ? error.message : String(error)}`].join("\n")
        });
      }
      reason = this.queuedReason;
      eventFees = this.queuedEventFees;
      this.queuedReason = null;
      this.queuedEventFees = new Set();
    }
    this.inFlight = false;
  }
}

function startExecuteEventListener(
  config: Config,
  provider: WebSocketProvider,
  runner: EvaluationRunner,
  notifier: BarkNotifier | null
): ContractListener {
  const contract = new Contract(config.executorAddress, EXECUTOR_ABI, provider);

  contract.on("ArbitrageExecuted", (flashAmount, wethSpent, profit, caller, profitRecipient, event) => {
    const hash = event?.log?.transactionHash ?? "unknown";
    log(
      [
        "ArbitrageExecuted detected",
        `hash=${hash}`,
        `flash=${format(BigInt(flashAmount))}`,
        `spent=${format(BigInt(wethSpent))}`,
        `profit=${format(BigInt(profit))}`,
        `caller=${caller}`,
        `profitRecipient=${profitRecipient}`
      ].join(" ")
    );
    sendNotification(notifier, {
      title: "Executor Succeeded",
      body: [
        `Profit: ${format(BigInt(profit))} WETH`,
        `Flash: ${format(BigInt(flashAmount))} WETH`,
        `Spent: ${format(BigInt(wethSpent))} WETH`
      ].join("\n")
    });
    runner.triggerEvent("execute-event", hash);
  });

  log("execute event listener registered");
  return { contract };
}

async function resolvePoolAddress(provider: JsonRpcProvider, config: Config): Promise<string> {
  if (config.poolAddress) return config.poolAddress;

  const factory = new Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, provider);
  const pool = getAddress(await factory.getPool(WETH, AWETH, config.poolFee));
  if (pool === ZERO_ADDRESS) {
    throw new Error(`No Uniswap V3 pool found for WETH/aWETH fee=${config.poolFee}`);
  }
  return pool;
}

async function resolvePoolAddressWithFallback(
  provider: JsonRpcProvider,
  fallbackProvider: JsonRpcProvider | null,
  config: Config
): Promise<string> {
  try {
    return await resolvePoolAddress(provider, config);
  } catch (error) {
    if (!fallbackProvider) throw error;
    console.warn(`[${timestamp()}] public RPC failed resolving pool; retrying with fallback RPC:`, error);
    return resolvePoolAddress(fallbackProvider, config);
  }
}

async function startPoolEventListener(
  config: Config,
  quoteProvider: JsonRpcProvider,
  quoteFallbackProvider: JsonRpcProvider | null,
  provider: WebSocketProvider,
  runner: EvaluationRunner
): Promise<ContractListener> {
  const poolAddress = await resolvePoolAddressWithFallback(quoteProvider, quoteFallbackProvider, config);
  const contract = new Contract(poolAddress, POOL_ABI, provider);
  const eventNames = ["Swap", "Mint", "Burn", "Collect", "Flash"] as const;

  for (const eventName of eventNames) {
    contract.on(eventName, (...args) => {
      const event = args[args.length - 1];
      const hash = event?.log?.transactionHash ?? "unknown";
      const blockNumber = event?.log?.blockNumber ?? "unknown";
      log(`pool ${eventName} detected pool=${poolAddress} hash=${hash} block=${blockNumber}`);
      runner.triggerEvent(`pool-${eventName.toLowerCase()}`, hash);
    });
  }

  log(`pool event listener registered pool=${poolAddress} events=${eventNames.join(",")}`);
  return { contract };
}

async function resolvePoolAddressForFee(
  provider: JsonRpcProvider,
  fallbackProvider: JsonRpcProvider | null,
  config: Config,
  fee: number
): Promise<string> {
  try {
    const factory = new Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, provider);
    const pool = getAddress(await factory.getPool(WETH, AWETH, fee));
    if (pool === ZERO_ADDRESS) {
      throw new Error(`No Uniswap V3 pool found for WETH/aWETH fee=${fee}`);
    }
    return pool;
  } catch (error) {
    if (!fallbackProvider) throw error;
    console.warn(`[${timestamp()}] public RPC failed resolving pool fee=${fee}; retrying with fallback RPC:`, error);
    const factory = new Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, fallbackProvider);
    const pool = getAddress(await factory.getPool(WETH, AWETH, fee));
    if (pool === ZERO_ADDRESS) {
      throw new Error(`No Uniswap V3 pool found for WETH/aWETH fee=${fee}`);
    }
    return pool;
  }
}

async function startPoolEventListeners(
  config: Config,
  quoteProvider: JsonRpcProvider,
  quoteFallbackProvider: JsonRpcProvider | null,
  provider: WebSocketProvider,
  runner: EvaluationRunner
): Promise<ContractListener[]> {
  if (config.poolAddress) {
    return [await startPoolEventListener(config, quoteProvider, quoteFallbackProvider, provider, runner)];
  }

  const eventNames = ["Swap", "Mint", "Burn", "Collect", "Flash"] as const;
  const poolEntries = await Promise.all(
    config.poolFees.map(async (fee) => ({
      fee,
      poolAddress: await resolvePoolAddressForFee(quoteProvider, quoteFallbackProvider, config, fee)
    }))
  );

  return poolEntries.map(({ fee, poolAddress }) => {
    const contract = new Contract(poolAddress, POOL_ABI, provider);
    for (const eventName of eventNames) {
      contract.on(eventName, (...args) => {
        const event = args[args.length - 1];
        const hash = event?.log?.transactionHash ?? "unknown";
        const blockNumber = event?.log?.blockNumber ?? "unknown";
        log(`pool ${eventName} detected fee=${fee} pool=${poolAddress} hash=${hash} block=${blockNumber}`);
        runner.triggerEvent(`pool-${fee}-${eventName.toLowerCase()}`, hash);
      });
    }
    log(`pool event listener registered fee=${fee} pool=${poolAddress} events=${eventNames.join(",")}`);
    return { contract };
  });
}

class WebSocketEventManager {
  private provider: WebSocketProvider | null = null;
  private listeners: ContractListener[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private reconnecting = false;

  public constructor(
    private readonly config: Config,
    private readonly quoteProvider: JsonRpcProvider,
    private readonly quoteFallbackProvider: JsonRpcProvider | null,
    private readonly runner: EvaluationRunner,
    private readonly notifier: BarkNotifier | null
  ) {}

  public start(): void {
    if (!this.config.wsRpcUrl) {
      log("websocket event listeners disabled: WS_RPC_URL not set");
      return;
    }
    void this.connect("startup");
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.cleanup();
  }

  private async connect(reason: string): Promise<void> {
    if (this.stopped || !this.config.wsRpcUrl) return;

    try {
      const provider = new WebSocketProvider(this.config.wsRpcUrl);
      this.provider = provider;
      this.attachSocketHandlers(provider);
      const listeners = [
        startExecuteEventListener(this.config, provider, this.runner, this.notifier),
        ...(await startPoolEventListeners(
          this.config,
          this.quoteProvider,
          this.quoteFallbackProvider,
          provider,
          this.runner
        ))
      ];
      if (this.stopped || this.provider !== provider) {
        await Promise.all(listeners.map((listener) => listener.contract.removeAllListeners()));
        await provider.destroy();
        return;
      }
      this.listeners = listeners;
      log(`websocket event listeners connected reason=${reason} ws=${redactUrl(this.config.wsRpcUrl)}`);
      this.reconnecting = false;
    } catch (error) {
      console.error(`[${timestamp()}] websocket listener setup failed:`, error);
      this.scheduleReconnect("setup-failed");
    }
  }

  private attachSocketHandlers(provider: WebSocketProvider): void {
    const websocket = (provider as unknown as { websocket?: WebSocketLikeWithEvents }).websocket;
    if (!websocket) {
      log("websocket close/error hooks unavailable; periodic fallback remains active");
      return;
    }

    const onClose = (...args: unknown[]) => {
      log(`websocket closed details=${JSON.stringify(args)}`);
      this.scheduleReconnect("close");
    };
    const onError = (error: unknown) => {
      console.error(`[${timestamp()}] websocket error:`, error);
      this.scheduleReconnect("error");
    };

    if (websocket.on) {
      websocket.on("close", onClose);
      websocket.on("error", onError);
      return;
    }

    websocket.addEventListener?.("close", onClose);
    websocket.addEventListener?.("error", onError);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnecting) return;

    this.reconnecting = true;
    void this.cleanup().finally(() => {
      if (this.stopped) return;
      log(`websocket reconnect scheduled reason=${reason} delayMs=${WS_RECONNECT_DELAY_MS}`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnecting = false;
        void this.connect(reason);
      }, WS_RECONNECT_DELAY_MS);
    });
  }

  private async cleanup(): Promise<void> {
    const listeners = this.listeners;
    const provider = this.provider;
    this.listeners = [];
    this.provider = null;

    await Promise.all(listeners.map((listener) => listener.contract.removeAllListeners()));
    if (provider) {
      await provider.destroy();
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const quoteProvider = new JsonRpcProvider(config.quoteRpcUrl, undefined, { staticNetwork: true });
  const quoteFallbackProvider =
    config.quoteFallbackRpcUrl === config.quoteRpcUrl
      ? null
      : new JsonRpcProvider(config.quoteFallbackRpcUrl, undefined, { staticNetwork: true });
  const txProvider = new JsonRpcProvider(config.txRpcUrl, undefined, { staticNetwork: true });
  const wallet = !config.dryRun && config.privateKey ? new Wallet(config.privateKey).connect(txProvider) : null;
  const executor = new Contract(config.executorAddress, EXECUTOR_ABI, config.dryRun ? txProvider : wallet);
  const notifier = config.barkDeviceKey
    ? new BarkNotifier(config.barkBaseUrl, config.barkDeviceKey, config.barkTitle, config.barkGroup)
    : null;
  let wsManager: WebSocketEventManager | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

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
      `quoteRpc=${redactUrl(config.quoteRpcUrl)}`,
      `quoteFallbackRpc=${quoteFallbackProvider ? redactUrl(config.quoteFallbackRpcUrl) : "disabled"}`,
      `txRpc=${redactUrl(config.txRpcUrl)}`,
      `wsRpc=${config.wsRpcUrl ? redactUrl(config.wsRpcUrl) : "disabled"}`,
      `poolAddress=${config.poolAddress ?? "auto"}`,
      `poolFees=${config.poolFees.join(",")}`,
      "quoteEngine=eth_call_center_with_local_refine",
      `maxEth=${config.maxEth}`,
      `lowCoarseMaxEth=${config.lowCoarseMaxEth}`,
      `lowCoarseStepEth=${config.lowCoarseStepEth}`,
      `coarseStepEth=${config.coarseStepEth}`,
      `fineStepEth=${config.fineStepEth}`,
      `fineWindowEth=${config.fineWindowEth}`,
      `quoteBatchSize=${config.quoteBatchSize}`,
      `localQuoteTimeoutMs=${config.localQuoteTimeoutMs}`,
      `localQuoteShadow=${config.localQuoteShadow}`,
      `swapPoolMinAwethRatioBps=${config.swapPoolMinAwethRatioBps}`,
      `eventDebounceMs=${config.eventDebounceMs}`,
      `intervalMs=${config.intervalMs}`,
      `deviationBps=${config.deviationBps}`,
      `deviationAweth=${format(config.deviationAweth)}`,
      `dryRun=${config.dryRun}`,
      `bark=${notifier ? "enabled" : "disabled"}`
    ].join(" ")
  );

  const runner = new EvaluationRunner(quoteProvider, quoteFallbackProvider, executor, config, notifier);
  wsManager = new WebSocketEventManager(config, quoteProvider, quoteFallbackProvider, runner, notifier);
  wsManager.start();
  runner.trigger("startup");

  if (config.intervalMs > 0) {
    timer = setInterval(() => {
      runner.trigger("interval");
    }, config.intervalMs);
  } else {
    log("interval disabled: MONITOR_INTERVAL_MS=0");
  }

  const shutdown = async (signal: string) => {
    log(`shutdown signal=${signal}`);
    if (timer) {
      clearInterval(timer);
    }
    await wsManager?.stop();
    await Promise.all([
      quoteProvider.destroy(),
      quoteFallbackProvider?.destroy() ?? Promise.resolve(),
      txProvider.destroy()
    ]);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
