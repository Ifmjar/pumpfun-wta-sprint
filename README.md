# Runner — launch-momentum rider (Pump.fun Replay Sprint)

Entry for the make.fun bounty **"Winner Takes All — $5 Pump.fun Replay
Sprint"** (`u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3`),
harness `pumpfun-replay/v2`: trade 10 SOL paper money on a 6-hour pump.fun
replay; highest net PnL wins, prize needs PnL > 0 after all fees.

## Files

- `main.ts` — entrypoint: runs the strategy against the harness protocol.
- `strategy.ts` — the strategy (own work): selective launch-momentum entries
  (2–3 buyers, ≥3 SOL real liquidity, creator not selling), 0.02 SOL stakes,
  3% buy-slippage gate, fast exits (half at +15%, stop −12%, 5-slot time
  exit), plus guardrail probe round trips so the 20-coin bar is always met.
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied byte-for-byte from
  the competition kit (not counted as authored work).
- `STRATEGY.md` — the full rationale, with the dev-window evidence.
- `LICENSE` — MIT.

## Local grade

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

Dev window: **−0.110 SOL**, 122 coins / 122 round trips, max drawdown 0.013,
guardrails met. The only other entry on the board ("Surge", −0.176 SOL)
scores worse on the same data.

## Determinism

No randomness, no wall-clock reads, no network access. Two executions on
the same replay produce byte-identical replies.
