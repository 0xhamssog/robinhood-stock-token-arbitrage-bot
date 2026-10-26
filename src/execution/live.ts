import type { Address } from "viem";
import type { AppConfig } from "../config/env.js";
import { STOCK_TOKEN_DECIMALS } from "../config/constants.js";
import { ExecutionError } from "../domain/errors.js";
import type { TradeRecord } from "../domain/trade.js";
import { log } from "../logging/logger.js";
import type { DexQuoteRequest } from "../marketdata/dex/types.js";
import { isUniswapXRouting, quoteUniswapLive } from "../marketdata/dex/uniswap.js";
import { applyBps, formatScaled } from "../normalize/units.js";
import type { Opportunity } from "../opportunity/types.js";
import { recordFill } from "../risk/engine.js";
import type { RiskBook, RiskVerdict } from "../risk/types.js";
import { paperFillPriceScaled, signedNotionalUsd } from "./paper.js";
import { newTradeId, type TradeRegistry } from "./registry.js";
import type { SwapBroadcast } from "./types.js";
import { fetchUniswapApproval, fetchUniswapSwap } from "./uniswap-swap.js";

export type { SwapBroadcast } from "./types.js";

export function executableWorseThanQuoted(args: {
  side: Opportunity["side"];
  quoted: bigint;
  fresh: bigint;
  maxSlippageBps: number;
}): boolean {
  const maxMove = applyBps(args.quoted, args.maxSlippageBps);
  if (args.side === "buy_dex") {
    return args.fresh > args.quoted + maxMove;
  }
  return args.fresh < args.quoted - maxMove;
}

function quoteRequestFromOpportunity(
  opportunity: Opportunity,
  config: AppConfig,
  swapper: Address,
): DexQuoteRequest {
  return {
    symbol: opportunity.symbol,
    token: opportunity.token as Address,
    quoteToken: config.quoteToken.address,
    quoteTokenSymbol: config.quoteToken.symbol,
    quoteTokenDecimals: config.quoteToken.decimals,
    tokenDecimals: STOCK_TOKEN_DECIMALS,
    sizeUsd: opportunity.sizeUsd,
    multiplier: opportunity.multiplier,
    side: opportunity.side === "buy_dex" ? "buy_token" : "sell_token",
    referenceTokenUsdScaled: opportunity.reference.valueUsdScaled,
    swapper,
  };
}

function failTrade(registry: TradeRegistry, opportunityId: string, reason: string, at: Date): TradeRecord {
  return registry.update(opportunityId, {
    state: "failed",
    at,
    failedAt: at,
    failureReason: reason,
  });
}

/**
 * Live Uniswap CLASSIC swap. Still only called after the risk engine allows.
 * UniswapX and cross-venue (second DEX not wired) are refused rather than guessed.
 */
export async function executeLiveSwap(args: {
  config: AppConfig;
  opportunity: Opportunity;
  verdict: RiskVerdict;
  book: RiskBook;
  registry: TradeRegistry;
  broadcast: SwapBroadcast;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<TradeRecord> {
  const now = args.now ?? Date.now();
  const at = new Date(now);
  const apiKey = args.config.uniswapApiKey?.trim();
  if (!apiKey) {
    throw new ExecutionError("LIVE_TRADING=true requires UNISWAP_API_KEY");
  }
  if (args.opportunity.kind === "cross_venue") {
    throw new ExecutionError(
      "Live cross-venue execution needs a second DEX (Arcus/Pleiades). Phase 4 only broadcasts Uniswap CLASSIC swaps.",
    );
  }

  const fillScaled = paperFillPriceScaled(args.opportunity);
  let trade: TradeRecord = {
    id: newTradeId("live"),
    opportunityId: args.opportunity.id,
    symbol: args.opportunity.symbol,
    side: args.opportunity.side,
    kind: args.opportunity.kind,
    mode: "live",
    state: "validated",
    detectedAt: args.opportunity.detectedAt,
    expiresAt: args.opportunity.expiresAt,
    token: args.opportunity.token,
    multiplier: args.opportunity.multiplierDecimal,
    sizeUsd: args.opportunity.sizeUsd,
    dexPriceUsd: args.opportunity.dex.valueUsd,
    fillPriceUsd: formatScaled(fillScaled),
    referencePriceUsd: args.opportunity.reference.valueUsd,
    extraFeeUsd: args.opportunity.costs.extraFeeUsd,
    slippageUsd: args.opportunity.costs.slippageUsd,
    slippageBps: args.opportunity.costs.slippageBps,
    gasUsd: args.opportunity.costs.gasUsd,
    gasSource: args.opportunity.costs.gasSource,
    riskBufferUsd: args.opportunity.costs.riskBufferUsd,
    grossEdgeUsd: args.opportunity.costs.grossEdgeUsd,
    netEdgeUsd: args.opportunity.costs.netEdgeUsd,
    realizedPnlUsd: args.opportunity.costs.netEdgeUsd,
    signedNotionalUsd: signedNotionalUsd(args.opportunity),
    riskCode: args.verdict.code,
    riskReason: args.verdict.reason,
    fillRecorded: false,
    states: [{ state: "validated", at }],
  };
  args.registry.claim(trade);

  log.warn("execution.directional_leg", {
    reason:
      "reference_vs_onchain live path submits a single Uniswap swap vs USDG. It is not mint/redeem and does not lock a second venue.",
    symbol: args.opportunity.symbol,
    side: args.opportunity.side,
  });

  try {
    const request = quoteRequestFromOpportunity(args.opportunity, args.config, args.broadcast.address);
    const fresh = await quoteUniswapLive(request, {
      apiKey,
      estimatedGasUsd: args.config.estimatedGasUsd,
      slippageBps: args.config.risk.maxSlippageBps,
      fetchImpl: args.fetchImpl,
    });
    trade = args.registry.update(args.opportunity.id, { state: "quoted", at });

    if (isUniswapXRouting(fresh.routing)) {
      throw new ExecutionError(
        "Fresh Uniswap quote routed UniswapX; Phase 4 live path only broadcasts CLASSIC swaps",
      );
    }
    if (!fresh.rawQuote) {
      throw new ExecutionError("Fresh Uniswap quote missing raw body for POST /swap");
    }
    if (
      executableWorseThanQuoted({
        side: args.opportunity.side,
        quoted: args.opportunity.dex.valueUsdScaled,
        fresh: fresh.executable.valueUsdScaled,
        maxSlippageBps: args.config.risk.maxSlippageBps,
      })
    ) {
      throw new ExecutionError(
        `Fresh Uniswap executable ${fresh.executable.valueUsd} moved more than ${args.config.risk.maxSlippageBps} bps vs quoted ${args.opportunity.dex.valueUsd}`,
      );
    }

    const tokenIn =
      args.opportunity.side === "buy_dex" ? args.config.quoteToken.address : (args.opportunity.token as Address);
    const amount = fresh.inputAmount;
    if (!amount) {
      throw new ExecutionError("Fresh Uniswap quote missing inputAmount for /check_approval");
    }

    const approval = await fetchUniswapApproval({
      apiKey,
      walletAddress: args.broadcast.address,
      token: tokenIn,
      amount,
      fetchImpl: args.fetchImpl,
    });
    if (approval) {
      const approvalHash = await args.broadcast.send({
        to: approval.to,
        data: approval.data,
        value: approval.value,
      });
      const approvalWait = await args.broadcast.wait(approvalHash.hash);
      if (approvalWait.status !== "success") {
        throw new ExecutionError(`Token approval transaction reverted (${approvalHash.hash})`);
      }
    }

    const swap = await fetchUniswapSwap({
      apiKey,
      quoteResponse: fresh.rawQuote,
      fetchImpl: args.fetchImpl,
    });
    if (swap.from !== args.broadcast.address) {
      throw new ExecutionError(
        `swap.from ${swap.from} does not match wallet ${args.broadcast.address}; refusing to broadcast`,
      );
    }

    const sent = await args.broadcast.send({
      to: swap.to,
      data: swap.data,
      value: swap.value,
      gas: swap.gas,
    });
    const submittedAt = new Date();
    trade = args.registry.update(args.opportunity.id, {
      state: "submitted",
      at: submittedAt,
      submittedAt,
      txHash: sent.hash,
    });
    log.info("execution.submitted", {
      id: trade.id,
      opportunityId: trade.opportunityId,
      txHash: sent.hash,
      mode: "live",
      symbol: trade.symbol,
    });

    trade = args.registry.update(args.opportunity.id, {
      state: "pending",
      at: submittedAt,
      pendingAt: submittedAt,
      txHash: sent.hash,
    });

    const receipt = await args.broadcast.wait(sent.hash);
    if (receipt.status !== "success") {
      const failed = failTrade(
        args.registry,
        args.opportunity.id,
        `Transaction reverted (${sent.hash})`,
        new Date(),
      );
      log.error("execution.failed", {
        id: failed.id,
        txHash: sent.hash,
        reason: failed.failureReason,
      });
      return failed;
    }

    recordFill(args.book, {
      symbol: args.opportunity.symbol,
      signedNotionalUsd: trade.signedNotionalUsd,
      realizedPnlUsd: Number(trade.realizedPnlUsd),
    });
    const confirmedAt = new Date();
    trade = args.registry.update(args.opportunity.id, {
      state: "confirmed",
      at: confirmedAt,
      confirmedAt,
      txHash: sent.hash,
      fillRecorded: true,
    });
    log.info("execution.confirmed", {
      id: trade.id,
      opportunityId: trade.opportunityId,
      txHash: sent.hash,
      mode: "live",
      symbol: trade.symbol,
      sizeUsd: trade.sizeUsd,
      fillPriceUsd: trade.fillPriceUsd,
      multiplier: trade.multiplier,
      gasUsd: trade.gasUsd,
      netEdgeUsd: trade.netEdgeUsd,
      realizedPnlUsd: trade.realizedPnlUsd,
      riskCode: trade.riskCode,
    });
    return trade;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const current = args.registry.getByOpportunityId(args.opportunity.id);
    if (current && current.state !== "failed") {
      const failed = failTrade(args.registry, args.opportunity.id, reason, new Date());
      log.error("execution.failed", {
        id: failed.id,
        txHash: failed.txHash ?? null,
        reason,
      });
      return failed;
    }
    throw err;
  }
}
