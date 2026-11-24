// Adaptive equal-weight pump.fun paper-trading bot (variant C).
//
// Idea: breadth beats picking. Buy a small, equal-weighted stake in many fresh
// coins as soon as they show real liquidity and early traction, size each stake
// inversely to the coin's own early volatility, and get out quickly on a
// take-profit, a stop-loss or a time limit. A portfolio-level drawdown brake
// pauses new entries when the book is bleeding, so one bad stretch cannot
// compound into a blow-up.
//
// Everything here is deterministic: no clock, no randomness, no network, no
// environment reads. All decisions come from the harness state (slots, reserves,
// fills). Iteration order is fixed (batch event order for entries, sorted mint
// order for exits).

import type { Batch, Bot, BotState, BuyInput, OrderInput, SellInput } from './vendor/makefun-bot.ts';

export interface AdaptiveParams {
  /** Base stake per coin, in lamports (0.05 SOL). */
  baseStakeLamports: bigint;
  /** Smallest stake we will ever place (0.02 SOL). */
  minStakeLamports: bigint;
  /** Largest stake we will ever place (0.10 SOL). */
  maxStakeLamports: bigint;
  /** Reference per-trade log-return volatility used to scale stakes. */
  refVol: number;
  /** Trades observed before a coin can be bought. */
  minTrades: number;
  /** Minimum price rise from the create price before entry (early traction). */
  minRise: number;
  /** Take-profit: exit when the price is this multiple of the fill price. */
  takeProfit: number;
  /** Stop-loss: exit when the price falls to this multiple of the fill price. */
  stopLoss: number;
  /** Time exit: sell whatever is left after this many slots held. */
  holdSlots: number;
  /** Drawdown from the equity peak that pauses new buys. */
  brakeDrawdown: number;
  /** Equity must recover to this drawdown before buys resume. */
  brakeResumeDrawdown: number;
  /** Drawdown from the peak that halts new buys for the rest of the run. */
  haltDrawdown: number;
  /** Buy slippage tolerance, bps. Kept tight (2%): a fill that ran away from
      the decision price in the 2-slot latency is rejected rather than chased. */
  buySlippageBps: number;
  /** Sell slippage tolerance, bps. */
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: AdaptiveParams = {
  baseStakeLamports: 50_000_000n,
  minStakeLamports: 20_000_000n,
  maxStakeLamports: 100_000_000n,
  refVol: 0.02,
  minTrades: 3,
  minRise: 0.05,
  takeProfit: 1.15,
  stopLoss: 0.85,
  holdSlots: 750,
  brakeDrawdown: 0.08,
  brakeResumeDrawdown: 0.04,
  haltDrawdown: 0.2,
  buySlippageBps: 200,
  sellSlippageBps: 2000,
};

interface CoinTrack {
  /** Price (virtual quote / virtual token) at creation. */
  createPrice: number;
  /** Latest observed price. */
  price: number;
  /** Trades seen so far. */
  trades: number;
  /** Sum of squared log-returns between consecutive trade prices. */
  sumSqLogRet: number;
  /** Number of log-returns accumulated. */
  nRet: number;
  /** Whether an entry decision has been made for this coin. */
  decided: boolean;
}

interface HeldInfo {
  /** Cost per token implied by the buy fill (quote spent / tokens received). */
  entryPrice: number;
  /** Slot the buy filled. */
  entrySlot: number;
  /** True once the buy fill has arrived and entryPrice is the fill price. */
  filled: boolean;
}

const priceOf = (c: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): number =>
  Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);

/** Mark-to-market value of a token balance on a curve (ignores fees; brake only). */
function markValue(tokens: bigint, curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): bigint {
  const p = priceOf(curve);
  return BigInt(Math.floor(Number(tokens) * p));
}

export function createAdaptiveBot(params: AdaptiveParams = DEFAULT_PARAMS): Bot {
  const tracks = new Map<string, CoinTrack>();
  const held = new Map<string, HeldInfo>();
  let peakEquity = 0n;
  let braking = false;
  let halted = false;

  function equity(state: BotState): bigint {
    let e = state.cash;
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve !== undefined && !curve.complete) e += markValue(pos.token_amount, curve);
    }
    return e;
  }

  function updateBrake(state: BotState): void {
    const e = equity(state);
    if (e > peakEquity) peakEquity = e;
    if (peakEquity === 0n) return;
    const dd = Number(peakEquity - e) / Number(peakEquity);
    if (dd >= params.haltDrawdown) halted = true;
    if (dd >= params.brakeDrawdown) braking = true;
    else if (dd <= params.brakeResumeDrawdown) braking = false;
  }

  function volScaledStake(t: CoinTrack): bigint {
    let stake = params.baseStakeLamports;
    if (t.nRet > 0) {
      const vol = Math.sqrt(t.sumSqLogRet / t.nRet);
      const clampedVol = Math.max(vol, 0.005);
      const scaled = (Number(params.baseStakeLamports) * params.refVol) / clampedVol;
      stake = BigInt(Math.floor(scaled));
    }
    if (stake < params.minStakeLamports) stake = params.minStakeLamports;
    if (stake > params.maxStakeLamports) stake = params.maxStakeLamports;
    return stake;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const { caps } = state.hello;
      const tx = state.txFeeLamports();

      // Learn entry prices from buy fills: cost per token actually paid.
      for (const f of batch.fills) {
        if (f.side === 'buy' && f.status === 'filled') {
          const paid = Number(f.quote_lamports);
          const tokens = Number(f.token_amount);
          if (paid > 0 && tokens > 0) {
            const cost = paid / tokens;
            const info = held.get(f.mint);
            if (info !== undefined) {
              info.entryPrice = cost;
              info.entrySlot = f.slot;
              info.filled = true;
            }
          }
        } else if (f.side === 'sell' && f.status === 'filled') {
          if (!state.positions.has(f.mint)) held.delete(f.mint);
        }
      }

      // Fold this batch's events into per-coin tracks first.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const curve = state.curves.get(e.mint);
          if (curve !== undefined) {
            const p = priceOf(curve);
            tracks.set(e.mint, { createPrice: p, price: p, trades: 0, sumSqLogRet: 0, nRet: 0, decided: false });
          }
        } else if (e.event === 'TradeEvent') {
          const t = tracks.get(e.mint);
          const curve = state.curves.get(e.mint);
          if (t !== undefined && curve !== undefined) {
            const p = priceOf(curve);
            if (t.trades > 0 && t.price > 0 && p > 0) {
              const lr = Math.log(p / t.price);
              t.sumSqLogRet += lr * lr;
              t.nRet += 1;
            }
            t.price = p;
            t.trades += 1;
          }
        } else if (e.event === 'CompleteEvent') {
          tracks.delete(e.mint);
          held.delete(e.mint);
        }
      }

      // Drop positions the harness already closed (complete / flatten). A buy
      // still in flight has no position yet, so keep those entries.
      const buyPending = new Set<string>();
      for (const p of state.pending.values()) if (p.order.side === 'buy') buyPending.add(p.order.mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !buyPending.has(mint)) held.delete(mint);
      }

      updateBrake(state);

      // Exits: take-profit, stop-loss or time exit, all measured against the
      // actual fill price. Sorted mint order: deterministic.
      const heldMints = [...held.keys()].sort();
      for (const mint of heldMints) {
        const info = held.get(mint)!;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;
        const sellPending = [...state.pending.values()].some((p) => p.order.mint === mint && p.order.side === 'sell');
        if (sellPending) continue;
        const p = priceOf(curve);
        if (!info.filled) continue;
        const ratio = info.entryPrice > 0 ? p / info.entryPrice : 1;
        const agedOut = state.slot - info.entrySlot >= params.holdSlots;
        if (ratio >= params.takeProfit || ratio <= params.stopLoss || agedOut) {
          const sell: SellInput = { side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: params.sellSlippageBps };
          orders.push(sell);
          held.delete(mint);
        }
      }

      // Entries: fresh coins with liquidity, equal-weight, vol-scaled.
      if (!halted && !braking) {
        let free = state.freeCashLamports();
        let slots = caps.max_open_positions - state.committedPositionCount();
        for (const e of batch.events) {
          if (orders.length >= caps.max_orders_per_batch) break;
          if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
          const t = tracks.get(e.mint);
          const curve = state.curves.get(e.mint);
          if (t === undefined || t.decided || curve === undefined || curve.complete) continue;
          if (t.trades < params.minTrades) continue;
          if (t.createPrice <= 0 || t.price / t.createPrice - 1 < params.minRise) continue;
          if (state.positions.has(e.mint)) continue;
          const cap = state.maxBuyLamports(e.mint);
          if (cap < params.minStakeLamports) continue;
          const stake = volScaledStake(t);
          const amount = cap < stake ? cap : stake;
          if (amount < params.minStakeLamports) continue;
          if (slots <= 0 || free < amount + tx) continue;
          const buy: BuyInput = { side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: params.buySlippageBps };
          orders.push(buy);
          t.decided = true;
          // Provisional entry info until the fill arrives with the true cost.
          held.set(e.mint, { entryPrice: t.price, entrySlot: state.slot, filled: false });
          free -= amount + tx;
          slots -= 1;
        }
      }

      return orders;
    },
  };
}
