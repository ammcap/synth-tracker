# SynthTracker: SN50 Polymarket Copy-Trader

A script designed to track Synth's — Bittensor Subnet 50 (SN50) — proxy wallet on Polymarket, executing limit orders to replicate the state of short-term digital asset binary option positions.

## TODOS (small lifts)

- merge proper TRADE (buys and sells) history from `synth-history-graph.js` with proper REDEEM history from `synth-history.js`
- update `analyze-trades.js` to use new output

---

## TODOS (bigger lifts)

#### Meta-analysis of Synth's performance (worst vs best days, aka max drawdown vs recovery periods, streak tracking, etc.)

#### Direct API integration from SN50.

#### Deploy some sort of local or just fine-tuned model to act as some kind of governance entity over the bot's logic
- telemetry synthsis and action on this synethsis
- could allow model other controls of the bot
- etc.

*This software is for educational and entertainment purposes only. Don't sue me. My Dad is a laywer.*
