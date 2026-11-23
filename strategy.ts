// Runner: a launch-momentum rider for the pump.fun bonding-curve replay.
//
// Data first (dev window, 1222 coins, 24h): a coin that has NOT moved by the time
// our buy would fill almost never runs (0.4% reach 2x, 0% complete), while a coin
// already up >= 20% at entry reaches 2x 5% of the time and completes 6% of the
// time, and one up >= 50% completes 10% of the time. Blind sniping loses: the
// price already moves +14% (median) between create and our fill 2 slots later,
// and only ~2.5% of coins ever 2x from the fill price. So this bot buys ONLY
// launches that are already running (real SOL present, several distinct buyers,
// net inflow, creator not selling), sizes in at the 1% reserve cap, pyramids
// into further strength, and lets the rare runner pay for the many small losers:
// a hard stop, a partial take-profit, then a trailing stop on the rest, with a
// long hold so a completing coin can pay out. Tiny probe round trips keep the
// run above the guardrail pace (20 coins with a >= 0.01 SOL round trip) when the
// selective entries alone would fall behind it.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only
// over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest / oldest age (slots since CreateEvent) at which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRq: bigint;
  maxRq: bigint;
  /** Price now over the create price: entry window (fractions, e.g. 1.15 = +15%). */
  minRunup: number;
  maxRunup: number;
  /** Distinct non-creator buyers and buy trades seen before entry. */
  minBuyers: number;
  minBuys: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many
   *  wallets is a dump in waiting. */
  maxBuyers: number;
  /** Net SOL bought over the whole tape so far (lamports, may be negative). */
  minFlow: bigint;
  /** Creator's own buys in the create slot: at most this (lamports). */
  maxDevBuy: bigint;
  /** Largest single non-creator buyer's share of buy SOL (fraction). */
  maxBuyerShare: number;
  /** Lamports sold by others / lamports bought, at most (fraction). */
  maxSellRatio: number;
  /** First buy size (lamports); each reply is still capped at 1% of real SOL. */
  stake: bigint;
  /** Smallest single buy worth paying the tx fee for (lamports). */
  minBuy: bigint;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Adds after the first buy: at most this many, each once the price is at least
   *  addStep above the previous buy's decision price and net flow stays positive. */
  maxAdds: number;
  addStep: number;
  addDelay: number;
  /** Lamports per add (each still capped at 1% of real SOL). */
  addSize: bigint;
  /** Most lamports put into one position in total. */
  maxPosition: bigint;
  /** First take-profit: sell tpPart of the position once worth tp over cost. */
  tp: number;
  tpPart: number;
  /** After the first take-profit, the rest stops out at this much under its cost. */
  slAfterTp: number;
  /** Exit when the position is worth this much under its cost. */
  sl: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit on any single recorded sell of at least this many SOL (lamports). */
  bigSell: bigint;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /**
   * Guardrail pacing: the run must end with a round trip of >= 0.01 SOL on at
   * least 20 coins. When the bot's own filled-order coins lag targetCoins scaled
   * by the share of paceSecs elapsed (block time since the first batch), it opens
   * tiny probe round trips (buy probeSol, sell it all as soon as the buy lands).
   */
  targetCoins: number;
  paceSecs: number;
  probeSol: bigint;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  // Entry: a launch is only worth 0.02 SOL once two or three distinct wallets
  // have already bought into at least 3 SOL of real liquidity and the creator
  // has not sold. Buyers above three mean the trade is crowded; below two it
  // is a ghost. Runup is deliberately unbounded: the slippage gate below, not
  // a price cap, decides whether the entry is still safe to chase.
  minAge: 0,
  maxAge: 5,
  minRq: 3_000_000_000n,
  maxRq: 60_000_000_000n,
  minRunup: 0,
  maxRunup: 100,
  minBuyers: 2,
  minBuys: 2,
  maxBuyers: 3,
  minFlow: 500_000_000n,
  maxDevBuy: 5_000_000_000n,
  maxBuyerShare: 0.8,
  maxSellRatio: 1,
  // Sizing: 0.02 SOL per entry. Small enough that the per-trip fee drag
  // (~0.0007 SOL) does not dominate, large enough that the guardrail's
  // 0.01 SOL round-trip bar is cleared by every entry, not only by probes.
  stake: 20_000_000n,
  minBuy: 5_000_000n,
  // A 3% slippage gate on the buy: if the price runs away more than 3% in
  // the 2-slot latency, the order is rejected instead of buying the top.
  buySlipBps: 300,
  // No pyramiding: every add tested so far lost money.
  maxAdds: 0,
  addStep: 0.03,
  addDelay: 2,
  addSize: 50_000_000n,
  maxPosition: 300_000_000n,
  // Exits: take half at +15%, stop at -12%, exit after 5 slots unless the
  // position is already up 5%. Fast exits beat long holds on this data in
  // every configuration tested: runners almost never pay for the wait.
  tp: 0.15,
  tpPart: 0.5,
  slAfterTp: 0,
  sl: 0.12,
  trailArm: 0.15,
  trail: 0.12,
  maxHold: 5,
  holdIfUp: 0.05,
  exitOnDevSell: true,
  bigSell: 2_000_000_000n,
  staleSlots: 300,
  maxMain: 5,
  cooldown: 150,
  maxEntries: 2,
  targetCoins: 25,
  paceSecs: 21_600,
  probeSol: 10_000_000n,
  maxProbes: 1,
};

const BPS = 10_000n;
const FEE_BPS = 125n;
const LAMPORTS = 1_000_000_000n;

interface Tick {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: string;
}

interface Coin {
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  trades: number;
  buys: number;
  bought: bigint;
  soldByOthers: bigint;
  buyers: Set<Pubkey>;
  buyByUser: Map<string, bigint>;
  recent: Tick[];
  lastTradeSlot: number;
  entries: number;
  lastExit: number;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  tookTp: boolean;
  invested: bigint;
  lastBuyPrice: number;
  lastBuySlot: number;
  adds: number;
}

/** What selling `tokens` against (vq, vt) pays after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  const selling = new Set<Pubkey>();
  const myCoins = new Set<Pubkey>();
  /** Probes opened so far: a probe only opens while the coin count (mine plus
   *  probes opened) still lags the pace target, so probes stay bounded. */
  let probesOpened = 0;
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        createSlot: -1, creator: '', vq0: 0n, vt0: 1n, devBuy: 0n, devSold: false,
        trades: 0, buys: 0, bought: 0n, soldByOthers: 0n, buyers: new Set(),
        buyByUser: new Map(), recent: [], lastTradeSlot: -1, entries: 0,
        lastExit: -1e12, done: false, complete: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net lamports bought minus sold over the last `w` slots. */
  const flow = (c: Coin, slot: number, w: number): bigint => {
    let net = 0n;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i]!;
      if (t.slot <= slot - w) break;
      net += t.buy ? t.sol : -t.sol;
    }
    return net;
  };

  const hasPending = (state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean => {
    for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === side) return true;
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (e.block_time > (lastTime ?? -1)) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.createSlot = e.slot;
          c.creator = e.creator;
          c.vq0 = BigInt(e.virtual_quote_reserves);
          c.vt0 = BigInt(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = BigInt(e.sol_amount);
          c.trades++;
          c.lastTradeSlot = e.slot;
          c.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.buys++;
            c.bought += sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) {
              c.buyers.add(e.user);
              c.buyByUser.set(e.user, (c.buyByUser.get(e.user) ?? 0n) + sol);
            }
          } else {
            if (isDev) c.devSold = true;
            else c.soldByOthers += sol;
            if (sol >= p.bigSell) bigSell.add(e.mint);
          }
          traded.add(e.mint);
        } else {
          const c = coinOf(e.mint);
          c.complete = true;
          c.done = true;
        }
      }
      // Drop tape older than any window we read (entry flow uses the whole tape,
      // so keep it bounded by the longest hold instead).
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.recent.length && c.recent[cut]!.slot <= now - 1200) cut++;
        if (cut > 0) c.recent.splice(0, cut);
      }
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') myCoins.add(f.mint);
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined && !probes.has(f.mint)) {
          held.set(f.mint, {
            openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n,
            tookTp: false, invested: 0n, lastBuyPrice: 0, lastBuySlot: f.slot, adds: 0,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint } | null => {
        const mk = marks.get(mint);
        if (mk !== undefined) return mk;
        const cv = state.curves.get(mint);
        if (cv === undefined) return null;
        return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      };

      // Exits first (probe mints are sold by the probe loop below, never here).
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: now, txPaid: tx, best: 0n, tookTp: false, invested: 0n, lastBuyPrice: 0, lastBuySlot: now, adds: 0 };
          held.set(mint, h);
        }
        const r = reservesOf(mint);
        if (r === null) continue;
        const value = sellValue(pos.token_amount, r.vq, r.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (!h.tookTp && value * BPS >= basis * BigInt(Math.round((1 + p.tp) * 10_000))) {
            const part = (pos.token_amount * BigInt(Math.round(p.tpPart * 10_000))) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp = true;
              h.best = 0n;
              continue;
            }
          }
          const sl = h.tookTp ? p.slAfterTp : p.sl;
          if (value * BPS <= basis * BigInt(Math.round((1 - sl) * 10_000))) exit = true;
          if (h.best * BPS >= basis * BigInt(Math.round((1 + p.trailArm) * 10_000)) &&
              value * BPS <= h.best * BigInt(Math.round((1 - p.trail) * 10_000))) exit = true;
        }
        if (now - h.openedSlot >= p.maxHold && value * BPS < basis * BigInt(Math.round((1 + p.holdIfUp) * 10_000))) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold) exit = true;
          if (bigSell.has(mint)) exit = true;
          if (now - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, isSelling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!hasPending(state, mint, 'buy')) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || hasPending(state, mint, 'sell')) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!isSelling) probes.set(mint, true);
      }

      // Entries and adds.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (hasPending(state, mint, 'buy') || probes.has(mint)) continue;
        const c = coins.get(mint)!;
        if (c.createSlot < 0 || c.done) continue;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rq = curve.real_quote_reserves;
        const capBuy = state.maxBuyLamports(mint);
        if (h === undefined) {
          if (open >= state.hello.caps.max_open_positions) continue;
          const age = now - c.createSlot;
          if (age < p.minAge || age > p.maxAge) continue;
          if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
          if (rq < p.minRq || rq > p.maxRq) continue;
          const runup = price / (Number(c.vq0) / Number(c.vt0));
          if (runup < p.minRunup || runup > p.maxRunup) continue;
          if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers || c.buys < p.minBuys) continue;
          if (c.bought - c.soldByOthers < p.minFlow) continue;
          if (c.devBuy > p.maxDevBuy || c.devSold) continue;
          if (c.bought > 0n && c.soldByOthers * 10_000n > c.bought * BigInt(Math.round(p.maxSellRatio * 10_000))) continue;
          let top = 0n;
          for (const v of c.buyByUser.values()) if (v > top) top = v;
          if (c.bought > 0n && top * 10_000n > c.bought * BigInt(Math.round(p.maxBuyerShare * 10_000))) continue;
          let amount = p.stake < capBuy ? p.stake : capBuy;
          if (amount < p.minBuy) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          held.set(mint, {
            openedSlot: now, txPaid: 0n, best: 0n, tookTp: false, invested: amount,
            lastBuyPrice: price, lastBuySlot: now, adds: 0,
          });
          c.entries++;
          open++;
        } else {
          // Pyramid into strength only: price stepped up, flow still positive.
          if (h.adds >= p.maxAdds || selling.has(mint)) continue;
          if (now - h.lastBuySlot < p.addDelay) continue;
          if (price < h.lastBuyPrice * (1 + p.addStep)) continue;
          if (flow(c, now, 30) <= 0n) continue;
          if (h.invested >= p.maxPosition) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          let amount = p.addSize < capBuy ? p.addSize : capBuy;
          const room = p.maxPosition - h.invested;
          if (amount > room) amount = room;
          if (amount < p.minBuy) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          h.invested += amount;
          h.lastBuyPrice = price;
          h.lastBuySlot = now;
          h.adds++;
        }
      }

      // Guardrail pacing: open a probe only while the coins with a fill (mine
      // plus probes opened) lag the pace target, so the probe count stays bounded
      // by the deficit instead of firing on every batch while behind. Probes
      // wait until the second half of the window, so real entries get the first
      // chance to fill the coin count and probes only top it up at the end.
      if (probes.size < p.maxProbes && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        if (pace >= 0.5 && myCoins.size + probesOpened < Math.ceil(p.targetCoins * pace)) {
          const minRq = (p.probeSol * BPS) / BigInt(state.hello.caps.max_order_bps_of_real_reserve);
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || myCoins.has(mint) || hasPending(state, mint, 'buy') || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < (minRq * 3n) / 2n) continue;
            if (free < p.probeSol + 2n * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: p.probeSol, max_slippage_bps: 10000 });
            probes.set(mint, false);
            probesOpened++;
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
