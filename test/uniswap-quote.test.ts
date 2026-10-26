import { describe, expect, it } from "vitest";
import { STOCK_TOKEN_DECIMALS } from "../src/config/constants.js";
import { VERIFIED_USDG } from "../src/config/constants.js";
import { loadConfig } from "../src/config/env.js";
import {
  createUniswapAdapter,
  executablePriceFromAmounts,
  extractQuoteAmounts,
  gasUsdFromQuote,
  quoteUniswapLive,
  UniswapQuoteError,
} from "../src/marketdata/dex/uniswap.js";
import type { DexQuoteRequest } from "../src/marketdata/dex/types.js";
import { formatScaled, parseDecimalToScaled } from "../src/normalize/units.js";

const request = {
  symbol: "AAPL",
  token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  quoteToken: VERIFIED_USDG.address,
  quoteTokenSymbol: "USDG",
  quoteTokenDecimals: 6,
  tokenDecimals: STOCK_TOKEN_DECIMALS,
  sizeUsd: 200,
  multiplier: parseDecimalToScaled("1"),
  side: "buy_token",
} as DexQuoteRequest;

describe("Uniswap quote parsing", () => {
  it("reads CLASSIC input/output amounts", () => {
    const parsed = extractQuoteAmounts({
      routing: "CLASSIC",
      quote: {
        input: { token: VERIFIED_USDG.address, amount: "200000000" },
        output: { token: request.token, amount: "2000000000000000000" },
        gasFeeUSD: "0.05",
        slippage: 0.5,
      },
    });
    expect(parsed.inputAmount).toBe(200000000n);
    expect(parsed.outputAmount).toBe(2n * 10n ** 18n);
    expect(formatScaled(executablePriceFromAmounts({ request, ...parsed }))).toBe("100");
    expect(gasUsdFromQuote(parsed, 0.05).source).toBe("uniswap_quote");
  });

  it("reads UniswapX orderInfo startAmounts and does not look for quote.output", () => {
    const parsed = extractQuoteAmounts({
      routing: "DUTCH_V3",
      quote: {
        orderInfo: {
          input: { token: VERIFIED_USDG.address, startAmount: "200000000", endAmount: "200000000" },
          outputs: [{ token: request.token, startAmount: "2000000000000000000", endAmount: "1990000000000000000" }],
        },
      },
    });
    expect(parsed.routing).toBe("DUTCH_V3");
    expect(gasUsdFromQuote(parsed, 0.05).source).toBe("uniswapx_gasless");
  });

  it("falls back to ESTIMATED_GAS_USD for CLASSIC quotes with no gasFeeUSD — never silent $0", () => {
    const parsed = extractQuoteAmounts({
      routing: "CLASSIC",
      quote: {
        input: { amount: "200000000" },
        output: { amount: "2000000000000000000" },
      },
    });
    const gas = gasUsdFromQuote(parsed, 0.05);
    expect(gas.source).toBe("config_fallback");
    expect(Number(gas.usd)).toBeGreaterThan(0);
  });

  it("refuses to call the Trading API without a key", async () => {
    await expect(
      quoteUniswapLive(request, { apiKey: "", estimatedGasUsd: 0.05 }),
    ).rejects.toBeInstanceOf(UniswapQuoteError);
  });

  it("posts chain 4663 and Universal Router 2.1.1 headers", async () => {
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toContain("/quote");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-universal-router-version")).toBe("2.1.1");
      expect(headers.get("x-api-key")).toBe("test-key");
      const body = JSON.parse(String(init?.body));
      expect(body.tokenInChainId).toBe("4663");
      expect(body.tokenOutChainId).toBe("4663");
      expect(body.type).toBe("EXACT_INPUT");
      return new Response(
        JSON.stringify({
          routing: "CLASSIC",
          quote: {
            input: { amount: "200000000" },
            output: { amount: "2000000000000000000" },
            gasFeeUSD: "0.04",
          },
        }),
        { status: 200 },
      );
    };
    const quote = await quoteUniswapLive(request, {
      apiKey: "test-key",
      estimatedGasUsd: 0.05,
      fetchImpl,
    });
    expect(quote.stub).toBe(false);
    expect(quote.executable.source).toBe("dex_uniswap");
    expect(quote.executable.valueUsd).toBe("100");
    expect(quote.estimatedGasUsd).toBe("0.04");
  });

  it("asks the Trading API for MAX_SLIPPAGE_BPS, so the quoted slippage passes the risk cap", async () => {
    const config = loadConfig({ SYMBOLS: "AAPL", MAX_SLIPPAGE_BPS: "30", UNISWAP_API_KEY: "test-key" });
    let requested: unknown;
    // The Trading API echoes the requested tolerance back as `quote.slippage` (percent).
    const fetchImpl: typeof fetch = async (_url, init) => {
      requested = JSON.parse(String(init?.body)).slippageTolerance;
      return new Response(
        JSON.stringify({
          routing: "CLASSIC",
          quote: {
            input: { amount: "200000000" },
            output: { amount: "2000000000000000000" },
            gasFeeUSD: "0.04",
            slippage: requested,
          },
        }),
        { status: 200 },
      );
    };
    const quote = await createUniswapAdapter(config, fetchImpl).quote(request);
    expect(requested).toBe(0.3);
    expect(quote.estimatedSlippageBps).toBe(30);
    expect(quote.estimatedSlippageBps).toBeLessThanOrEqual(config.risk.maxSlippageBps);
  });
});
