import { getAddress, isAddress } from "viem";
import type { AppConfig } from "../../config/env.js";
import {
  QUOTE_SWAPPER_DEFAULT,
  ROBINHOOD_CHAIN_ID,
  STOCK_TOKEN_DECIMALS,
  UNISWAP_AGENT_INFO,
  UNISWAP_TRADE_API_URL,
  UNISWAP_UNIVERSAL_ROUTER_VERSION,
} from "../../config/constants.js";
import {
  impliedUsdPerToken,
  makePrice,
  notionalUsdToTokenRaw,
  parseDecimalToScaled,
  usdNotionalToRaw,
  usdNumberToScaled,
} from "../../normalize/units.js";
import type { DexAdapter, DexQuote, DexQuoteRequest } from "./types.js";

export class UniswapQuoteError extends Error {
  readonly code = "UNISWAP_QUOTE" as const;
  constructor(message: string) {
    super(message);
    this.name = "UniswapQuoteError";
  }
}

interface QuoteAmounts {
  inputAmount: bigint;
  outputAmount: bigint;
  routing: string;
  gasFeeUsd?: string;
  slippage?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

/**
 * Parse CLASSIC (`quote.input/output`) and UniswapX (`quote.orderInfo`) shapes.
 * UniswapX has no `quote.output.amount`.
 */
export function extractQuoteAmounts(body: unknown): QuoteAmounts {
  const root = asRecord(body);
  if (!root) throw new UniswapQuoteError("Uniswap quote response is not an object");
  const routing = asString(root.routing) ?? "CLASSIC";
  const quote = asRecord(root.quote) ?? root;

  const classicIn = asRecord(quote.input);
  const classicOut = asRecord(quote.output);
  if (classicIn?.amount && classicOut?.amount) {
    return {
      inputAmount: BigInt(String(classicIn.amount)),
      outputAmount: BigInt(String(classicOut.amount)),
      routing,
      gasFeeUsd: asString(quote.gasFeeUSD) ?? asString(quote.gasFeeUsd),
      slippage: typeof quote.slippage === "number" ? quote.slippage : undefined,
    };
  }

  const orderInfo = asRecord(quote.orderInfo);
  const uniIn = asRecord(orderInfo?.input);
  const outputs = orderInfo?.outputs;
  const firstOut = Array.isArray(outputs) ? asRecord(outputs[0]) : undefined;
  const inAmt = asString(uniIn?.startAmount);
  const outAmt = asString(firstOut?.startAmount);
  if (inAmt && outAmt) {
    return {
      inputAmount: BigInt(inAmt),
      outputAmount: BigInt(outAmt),
      routing,
      gasFeeUsd: asString(quote.gasFeeUSD) ?? asString(quote.gasFeeUsd),
      slippage: typeof quote.slippage === "number" ? quote.slippage : undefined,
    };
  }

  throw new UniswapQuoteError(
    `Unrecognized Uniswap quote shape (routing=${routing}). Expected CLASSIC input/output or UniswapX orderInfo.`,
  );
}

export function gasUsdFromQuote(
  amounts: QuoteAmounts,
  estimatedGasUsd: number,
): { usd: string; source: DexQuote["gasSource"] } {
  const uniswapX = isUniswapXRouting(amounts.routing);
  if (amounts.gasFeeUsd !== undefined && amounts.gasFeeUsd !== "") {
    const parsed = Number(amounts.gasFeeUsd);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new UniswapQuoteError(`Invalid gasFeeUSD: ${amounts.gasFeeUsd}`);
    }
    if (parsed === 0 && uniswapX) {
      return { usd: "0", source: "uniswapx_gasless" };
    }
    return { usd: amounts.gasFeeUsd, source: "uniswap_quote" };
  }
  if (uniswapX) {
    return { usd: "0", source: "uniswapx_gasless" };
  }
  return { usd: estimatedGasUsd.toFixed(8).replace(/0+$/, "").replace(/\.$/, ""), source: "config_fallback" };
}

export function executablePriceFromAmounts(args: {
  request: DexQuoteRequest;
  inputAmount: bigint;
  outputAmount: bigint;
}): bigint {
  const { request, inputAmount, outputAmount } = args;
  if (request.side === "buy_token") {
    return impliedUsdPerToken({
      usdgAmountRaw: inputAmount,
      usdgDecimals: request.quoteTokenDecimals,
      tokenAmountRaw: outputAmount,
      tokenDecimals: request.tokenDecimals,
    });
  }
  return impliedUsdPerToken({
    usdgAmountRaw: outputAmount,
    usdgDecimals: request.quoteTokenDecimals,
    tokenAmountRaw: inputAmount,
    tokenDecimals: request.tokenDecimals,
  });
}

export function uniswapHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-api-key": apiKey,
    "x-universal-router-version": UNISWAP_UNIVERSAL_ROUTER_VERSION,
    "x-agent-info": UNISWAP_AGENT_INFO,
  };
}

export function isUniswapXRouting(routing: string | undefined): boolean {
  return routing === "DUTCH_V2" || routing === "DUTCH_V3" || routing === "PRIORITY";
}

export async function quoteUniswapLive(
  request: DexQuoteRequest,
  args: {
    apiKey: string;
    estimatedGasUsd: number;
    /** Slippage tolerance sent to the Trading API, in bps (MAX_SLIPPAGE_BPS). Defaults to 50. */
    slippageBps?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<DexQuote> {
  const apiKey = args.apiKey.trim();
  if (!apiKey) {
    throw new UniswapQuoteError("UNISWAP_API_KEY is empty");
  }
  if (!isAddress(request.token) || !isAddress(request.quoteToken)) {
    throw new UniswapQuoteError("token addresses must be 0x-prefixed 20-byte values");
  }

  const swapper = request.swapper ?? QUOTE_SWAPPER_DEFAULT;
  const tokenDecimals = request.tokenDecimals || STOCK_TOKEN_DECIMALS;
  const buy = request.side === "buy_token";

  let amount: string;
  let tokenIn: string;
  let tokenOut: string;
  if (buy) {
    tokenIn = getAddress(request.quoteToken);
    tokenOut = getAddress(request.token);
    amount = usdNotionalToRaw(request.sizeUsd, request.quoteTokenDecimals).toString();
  } else {
    if (request.referenceTokenUsdScaled === undefined) {
      throw new UniswapQuoteError("sell quotes require referenceTokenUsdScaled to size the order");
    }
    tokenIn = getAddress(request.token);
    tokenOut = getAddress(request.quoteToken);
    amount = notionalUsdToTokenRaw(
      usdNumberToScaled(request.sizeUsd),
      request.referenceTokenUsdScaled,
      tokenDecimals,
    ).toString();
  }

  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(`${UNISWAP_TRADE_API_URL}/quote`, {
    method: "POST",
    headers: uniswapHeaders(apiKey),
    body: JSON.stringify({
      swapper,
      tokenIn,
      tokenOut,
      tokenInChainId: String(ROBINHOOD_CHAIN_ID),
      tokenOutChainId: String(ROBINHOOD_CHAIN_ID),
      amount,
      type: "EXACT_INPUT",
      slippageTolerance: (args.slippageBps ?? 50) / 100,
      routingPreference: "BEST_PRICE",
    }),
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = asRecord(body)?.detail ?? asRecord(body)?.error ?? res.statusText;
    throw new UniswapQuoteError(`Uniswap /quote failed HTTP ${res.status}: ${String(detail)}`);
  }

  const parsed = extractQuoteAmounts(body);
  const priceScaled = executablePriceFromAmounts({
    request: { ...request, tokenDecimals },
    inputAmount: parsed.inputAmount,
    outputAmount: parsed.outputAmount,
  });
  const gas = gasUsdFromQuote(parsed, args.estimatedGasUsd);
  const side = buy ? "executable_buy" : "executable_sell";

  return {
    venue: "uniswap",
    stub: false,
    request: { ...request, tokenDecimals, swapper },
    executable: makePrice({
      symbol: request.symbol,
      source: "dex_uniswap",
      timestamp: new Date(),
      multiplier: request.multiplier,
      side,
      valueUsdScaled: priceScaled,
      meta: {
        quoteToken: request.quoteToken,
        sizeUsd: request.sizeUsd,
        routing: parsed.routing,
        stub: false,
      },
    }),
    feeBps: 0,
    estimatedSlippageBps: parsed.slippage !== undefined ? Math.round(parsed.slippage * 100) : undefined,
    estimatedGasUsd: gas.usd,
    gasSource: gas.source,
    routing: parsed.routing,
    inputAmount: parsed.inputAmount.toString(),
    outputAmount: parsed.outputAmount.toString(),
    rawQuote: asRecord(body),
    note: "Uniswap Trading API size-aware quote on chain 4663. AMM fees are inside the executable amounts.",
  };
}

export function createUniswapStubAdapter(referenceTokenUsdScaled: bigint): DexAdapter {
  return {
    venue: "uniswap",
    async quote(request: DexQuoteRequest): Promise<DexQuote> {
      const side = request.side === "buy_token" ? "executable_buy" : "executable_sell";
      return {
        venue: "uniswap",
        stub: true,
        request,
        executable: makePrice({
          symbol: request.symbol,
          source: "dex_uniswap_stub",
          timestamp: new Date(),
          multiplier: request.multiplier,
          side,
          valueUsdScaled: referenceTokenUsdScaled,
          meta: {
            quoteToken: request.quoteToken,
            quoteTokenSymbol: request.quoteTokenSymbol,
            sizeUsd: request.sizeUsd,
            stub: true,
          },
        }),
        feeBps: 0,
        estimatedSlippageBps: 0,
        estimatedGasUsd: "0",
        gasSource: "stub",
        note: "Stub quote — not executable. Set UNISWAP_API_KEY for Trading API quotes.",
      };
    },
  };
}

export function createUniswapAdapter(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): DexAdapter {
  if (!config.uniswapApiKey) {
    return {
      venue: "uniswap",
      async quote(request: DexQuoteRequest): Promise<DexQuote> {
        if (request.referenceTokenUsdScaled === undefined && request.side === "sell_token") {
          throw new UniswapQuoteError("sell quotes need a reference price even in stub mode");
        }
        const seed =
          request.referenceTokenUsdScaled ?? parseDecimalToScaled("0");
        if (seed === 0n) {
          throw new UniswapQuoteError("no seed price for Uniswap stub");
        }
        return createUniswapStubAdapter(seed).quote(request);
      },
    };
  }
  return {
    venue: "uniswap",
    quote: (request) =>
      quoteUniswapLive(
        { ...request, swapper: request.swapper ?? config.quoteSwapper },
        {
          apiKey: config.uniswapApiKey!,
          estimatedGasUsd: config.estimatedGasUsd,
          slippageBps: config.risk.maxSlippageBps,
          fetchImpl,
        },
      ),
  };
}
