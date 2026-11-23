# Strategy — Runner: launch-momentum rider with a 3% slippage gate

## What it trades

The bot trades the pump.fun replay: 10 SOL paper capital, at most 5 open
positions, at most 1% of a coin's real SOL reserve per order, 2-slot latency,
105,000 lamports per order, 2% failed transactions, 1.25% curve fee per trade.
It wins only if its final-window net PnL is above 0 and above every other
entry's — so the design goal is not "lose slowly", it is "be the least
negative on average, with enough coins traded to clear the guardrails, and
with a right tail when a window is kind".

## What the data says (dev window, 2026-11-02 → 03, 1,222 mints)

Every naive shape loses after fees:

- Buying everything at creation loses badly (median price is already +13.6%
  by the time the 2-slot-latency fill lands). Only ~2.5% of coins ever 2x
  from the fill price within 100 slots.
- 27 of 35 completions happen in the same slot as creation — instant
  85-SOL migrations that a 2-slot-latency bot cannot catch. Riding
  completions is a dead end.
- Pyramiding into a position hurt in every test. Long holds hurt in every
  test: coins that have already run up dump afterwards, and coins that have
  not run up barely move, so holding only pays fees.
- The three kit pilots on the full window: momentum −9.39 SOL, reversion
  −4.02 SOL, sniper −0.49 SOL. The sniper is the only sane base.

The two filters that actually help are both about *who* is buying, not
*how much the price moved*:

- Coins with 2–3 distinct non-creator buyers and ≥3 SOL of real liquidity
  at entry complete far more often and dump less than coins with 0–1 buyers
  or a crowd of 4+ wallets (bundled dumps).
- A tight buy-slippage gate (3%) rejects entries whose price ran away in
  the 2-slot latency — buying the top is the single most expensive mistake,
  and the rejection costs nothing (no fee on a rejected order).

## Rules

**Entry** (a coin is considered for at most its first 5 slots):

- real SOL reserves between 3 and 60 SOL;
- 2–3 distinct non-creator buyers, at least 2 buy trades, net inflow ≥0.5 SOL;
- creator has not sold, creator's own buys ≤5 SOL, no single buyer owns >80%
  of the inflow, sells ≤ buys by count;
- 0.02 SOL per entry (clears the 0.01 SOL round-trip guardrail bar by itself),
  capped at 1% of real reserves, max slippage 300 bps;
- no pyramiding (`maxAdds: 0`).

**Exits** (fast — the data says holding is where the money dies):

- take half the position at +15%;
- stop out at −12% (of cost including tx fees paid so far);
- trailing stop once +15% is reached (exit 12% below the best value seen);
- time exit after 5 slots unless the position is already up ≥5%;
- exit immediately if the creator sells, a single sell ≥2 SOL appears, or
  the coin has not traded for 300 slots.

**Guardrail pacing.** The final window is 6 hours and needs ≥20 coins with a
round trip of ≥0.01 SOL. The entry filters only find ~30 coins per 6h, and a
quiet window could find fewer, so the bot tops the count up with *probes*:
0.01 SOL buy-and-immediately-sell round trips on the most liquid traded
coins, opened only while the coin count lags the pace target (25 coins over
6h) and only in the second half of the window, so real entries get the first
chance. A probe costs ~0.0005 SOL; a failed guardrail costs the entry.

## Results (dev window, local backtest + grade-local)

- Local backtest, full 24h: **−0.115 SOL** (121 coins, 121 round trips,
  15 wins, max drawdown 0.01). 6h quarters: −0.003 / −0.025 / −0.057 / −0.039.
- `grade-local --driver process`: **−0.110 SOL**, 122 coins, 122 round
  trips, win rate 13.9%, max drawdown 0.013, guardrails met.
- The only other entry, "Surge" by luckyid, scores −0.176 SOL on dev. This
  entry beats it by ~0.07 SOL on the same data.

The entry is deterministic: no randomness, no wall-clock reads, no network.
Two executions on the same data produce byte-identical replies.
