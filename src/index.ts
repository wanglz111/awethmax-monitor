import "dotenv/config";

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
const INPUT_BUFFER_BPS = 1n;
const WS_RECONNECT_DELAY_MS = 5_000;
const EVENT_TX_DEDUPE_TTL_MS = 60_000;

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
  "event ArbitrageExecuted(uint256 flashAmount,uint256 wethSpent,uint256 profit,uint256 kairosPayment,address indexed caller,address indexed profitRecipient)"
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
  eventDebounceMs: number;
  intervalMs: number;
  deviationBps: number;
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
  const poolFee = parseInteger("POOL_FEE", 500);
  const poolFees = parseIntegerList("POOL_FEES");

  return {
    quoteRpcUrl: DEFAULT_RPC_URL,
    quoteFallbackRpcUrl: optional("QUOTE_FALLBACK_RPC_URL") ?? optional("QUOTE_RPC_URL") ?? txRpcUrl,
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
    fineWindowEth: parseNumber("FINE_WINDOW_ETH", 10),
    concurrency: parseInteger("QUOTE_CONCURRENCY", 6),
    quoteBatchSize: parseInteger("QUOTE_BATCH_SIZE", 20),
    eventDebounceMs: parseNonNegativeInteger("EVENT_DEBOUNCE_MS", 2_000),
    intervalMs: parseNonNegativeInteger("MONITOR_INTERVAL_MS", 600_000),
    deviationBps: parseInteger("UPDATE_DEVIATION_BPS", 2_000),
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

function shortHash(hash: string): string {
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
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

async function findBestQuote(provider: JsonRpcProvider, config: Config): Promise<Quote> {
  const multicall = new Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const quoter = new Contract(QUOTER_V2, QUOTER_ABI, provider);
  const quoterInterface = new Interface(QUOTER_ABI);

  function buildQuoteFromResult(
    fee: number,
    outEth: number,
    amountIn: bigint,
    sqrtPriceX96After: bigint,
    ticksCrossed: bigint,
    gasEstimate: bigint
  ): Quote {
    const amountOut = parseEther(String(outEth));
    const maxIn = amountIn + (amountIn * INPUT_BUFFER_BPS) / SCALE_BPS;
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

  function buildQuote(fee: number, outEth: number, returnData: string): Quote | null {
    try {
      const [amountIn, sqrtPriceX96After, ticksCrossed, gasEstimate] =
        quoterInterface.decodeFunctionResult("quoteExactOutputSingle", returnData);
      return buildQuoteFromResult(fee, outEth, amountIn, sqrtPriceX96After, ticksCrossed, gasEstimate);
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
      return buildQuoteFromResult(fee, outEth, amountIn, sqrtPriceX96After, ticksCrossed, gasEstimate);
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
      return quoteSingles(fee, outEthValues);
    }
  }

  async function quoteMany(outEthValues: number[]): Promise<Array<Quote | null>> {
    const batches = config.poolFees.flatMap((fee) =>
      chunk(outEthValues, config.quoteBatchSize).map((values) => ({ fee, values }))
    );
    const batchQuotes = await mapLimit(batches, config.concurrency, (batch) => quoteBatch(batch.fee, batch.values));
    return batchQuotes.flat();
  }

  const validQuotes = (quotes: Array<Quote | null>): Quote[] =>
    quotes
      .filter((item): item is Quote => item !== null)
      .filter((item) => item.sqrtPriceX96After !== MIN_SQRT_RATIO_PLUS_ONE && item.bufferedProfit > 0n)
      .sort((a, b) => (a.bufferedProfit < b.bufferedProfit ? 1 : -1));

  async function quoteCoarseUntilUnprofitable(outEthValues: number[]): Promise<Quote[]> {
    const feeQuotes = await mapLimit(config.poolFees, config.concurrency, async (fee) => {
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
    return fallbackQuote();
  }

  const highCoarseStart = Math.max(config.coarseStepEth, lowCoarseEnd + config.coarseStepEth);
  const validHighCoarse = await quoteCoarseUntilUnprofitable(range(highCoarseStart, config.maxEth, config.coarseStepEth));
  const validCoarse = [...validLowCoarse, ...validHighCoarse].sort((a, b) =>
    a.bufferedProfit < b.bufferedProfit ? 1 : -1
  );

  if (validCoarse.length === 0) {
    return fallbackQuote();
  }

  const center = validCoarse[0].outEth;
  const fineStart = Math.max(config.fineStepEth, center - config.fineWindowEth);
  const fineEnd = Math.min(config.maxEth, center + config.fineWindowEth);
  const fineQuotes = await quoteMany(range(fineStart, fineEnd, config.fineStepEth));
  const validFine = fineQuotes
    .filter((item): item is Quote => item !== null)
    .filter((item) => item.sqrtPriceX96After !== MIN_SQRT_RATIO_PLUS_ONE && item.bufferedProfit > 0n)
    .sort((a, b) => (a.bufferedProfit < b.bufferedProfit ? 1 : -1));

  return validFine[0] ?? validCoarse[0];
}

async function runOnce(
  quoteProvider: JsonRpcProvider,
  quoteFallbackProvider: JsonRpcProvider | null,
  executor: Contract,
  config: Config,
  notifier: BarkNotifier | null
): Promise<void> {
  let best: Quote;
  try {
    best = await findBestQuote(quoteProvider, config);
  } catch (error) {
    if (!quoteFallbackProvider) throw error;
    best = await findBestQuote(quoteFallbackProvider, config);
  }
  const current = BigInt(await executor.maxTargetAweth());
  const shouldUpdate = overDeviationThreshold(best.amountOut, current, config.deviationBps);

  log(
    [
      `recommended=${format(best.amountOut)}aWETH`,
      `fee=${best.fee}`,
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

  sendNotification(notifier, {
    title: "aWETH Cap Updated",
    body: [
      `New cap: ${format(best.amountOut)} aWETH`,
      `Old cap: ${format(current)} aWETH`,
      `Fee: ${best.fee}`,
      `Reason: ${best.reason}`,
      `Delta: ${deviationBps(best.amountOut, current)} bps`,
      `Tx: ${shortHash(tx.hash)}`,
      `Block: ${receipt.blockNumber}`
    ].join("\n")
  });
}

class EvaluationRunner {
  private inFlight = false;
  private queuedReason: string | null = null;
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEventReason: string | null = null;
  private readonly seenEventTxs = new Map<string, number>();

  public constructor(
    private readonly quoteProvider: JsonRpcProvider,
    private readonly quoteFallbackProvider: JsonRpcProvider | null,
    private readonly executor: Contract,
    private readonly config: Config,
    private readonly notifier: BarkNotifier | null
  ) {}

  public trigger(reason: string): void {
    if (this.inFlight) {
      this.queuedReason = reason;
      log(`evaluation queued reason=${reason}`);
      return;
    }

    this.inFlight = true;
    void this.runLoop(reason);
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

    this.pendingEventReason = this.pendingEventReason ? "event-batch" : reason;
    if (this.config.eventDebounceMs === 0) {
      const nextReason = this.pendingEventReason;
      this.pendingEventReason = null;
      this.trigger(nextReason);
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
      this.pendingEventReason = null;
      this.trigger(nextReason);
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

  private async runLoop(initialReason: string): Promise<void> {
    let reason: string | null = initialReason;
    while (reason) {
      log(`evaluation start reason=${reason}`);
      try {
        await runOnce(this.quoteProvider, this.quoteFallbackProvider, this.executor, this.config, this.notifier);
      } catch (error) {
        console.error(`[${timestamp()}] evaluation failed reason=${reason}:`, error);
        sendNotification(this.notifier, {
          title: "aWETH Monitor Failed",
          body: [`Reason: ${reason}`, `Error: ${error instanceof Error ? error.message : String(error)}`].join("\n")
        });
      }
      reason = this.queuedReason;
      this.queuedReason = null;
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

  contract.on("ArbitrageExecuted", (flashAmount, wethSpent, profit, kairosPayment, caller, profitRecipient, event) => {
    const hash = event?.log?.transactionHash ?? "unknown";
    log(
      [
        "ArbitrageExecuted detected",
        `hash=${hash}`,
        `flash=${format(BigInt(flashAmount))}`,
        `spent=${format(BigInt(wethSpent))}`,
        `profit=${format(BigInt(profit))}`,
        `kairos=${format(BigInt(kairosPayment))}`,
        `caller=${caller}`,
        `profitRecipient=${profitRecipient}`
      ].join(" ")
    );
    sendNotification(notifier, {
      title: "Executor Succeeded",
      body: [
        `Profit: ${format(BigInt(profit))} WETH`,
        `Flash: ${format(BigInt(flashAmount))} WETH`,
        `Spent: ${format(BigInt(wethSpent))} WETH`,
        `Tx: ${shortHash(hash)}`
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
    sendNotification(this.notifier, {
      title: "aWETH Monitor WS Reconnecting",
      body: `Reason: ${reason}`
    });
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
      `quoteBatchSize=${config.quoteBatchSize}`,
      `eventDebounceMs=${config.eventDebounceMs}`,
      `intervalMs=${config.intervalMs}`,
      `deviationBps=${config.deviationBps}`,
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
