# Persona presets

Six pre-built personas, each a complete dossier (bio + style + 10
example tweet→reply pairs). One tap in the `/new` flow loads the
whole thing into the campaign config — no manual prompt-engineering
required.

If none of the six fit, pick `✏ Custom` in the persona step to type
`name | bio | style` the old way (no examples — examples need a
multi-line collector, planned in PR2).

## Why presets matter

The OpenAI rewriter's voice fidelity is mostly driven by `examples`,
not `bio`/`style`. Bio is description; examples are demonstration.
The system prompt in `persona.js` injects up to 10 examples as
few-shot pairs. Going from 0 examples to 10 examples is roughly
3-5x more impactful than picking the "right" style description.

That's why the previous one-line `name | bio | style` form produced
generic-sounding replies — the strongest field was empty.

## The six presets

### 🦴 Cycle Veteran

Survived 2-3 cycles. Dry, skeptical, references specific past
patterns (luna, 3ac, ftx). The default-good choice if you don't
know which to pick.

Best fit for: general crypto reply, mixed feed, BTC/ETH-leaning
threads, broad-stroke takes.

Avoids: aggressive moonboy tone, financial advice, naive
optimism.

### 📐 DeFi Quant

Numeric, precision-first. Asks for funding/oi/tvl/apy/basis
specifics. Treats every claim as testable.

Best fit for: trading feeds, perp dex threads, lending/restaking
discussions, yield farming posts.

Avoids: vague "I think" claims, no-source assertions, vibes-only
takes.

### ⚡ SOL Degen

Fast, short, aggressive. Solana-ecosystem specific (Jupiter,
Bonk, pump.fun, Jito, Firedancer). Memecoin-savvy without being
a shill.

Best fit for: SOL ecosystem feeds, memecoin launches, SOL trader
threads, low-cap watch.

Avoids: long-form thinking, ETH-maxi bias, slow-thesis takes.

### 🌍 Macro Analyst

Big picture. ETF flows, Fed policy, on-chain capital rotation,
DXY correlation. Less price prediction, more flow analysis.

Best fit for: BTC threads, macro discussions, FOMC reactions,
ETF flow news, regulatory news.

Avoids: short-term scalp talk, memecoin engagement, trader
slang.

### 🔧 Builder/Dev

Engineering POV. Talks code, protocol design, dev ergonomics.
References specific tools (foundry, anchor, viem, slither).
Mostly ignores price.

Best fit for: dev/tech feeds, protocol launches, smart contract
discussions, web3 ux threads.

Avoids: trading takes, marketing speak, price predictions.

### 🪞 Contrarian

Reflexive opposite take, but with substance. Inverts the implied
frame in 5-15 words, then backs it up briefly.

Best fit for: hyped/consensus threads, "everyone is bullish/
bearish" posts, herd-think feeds where being the second voice
of dissent wins thread visibility.

Avoids: agreeing for the sake of agreement, contrarian-for-sport
without grounding.

## Switching personas mid-campaign

Currently the persona is set once when the campaign is created.
PR2 will add `/persona <campaign_id> <preset_id>` to swap mid-run
without recreating the campaign. Until then: stop → /new → pick
new preset.

## Adding your own preset

Edit `bot/src/persona/presets.js`, append a new entry to
`PERSONA_PRESETS`, and add a description block here. Each preset
needs ≥10 example pairs to outperform the neutral default voice.

Examples should be hand-written, not AI-generated. AI-generated
examples produce a feedback loop where every reply sounds vaguely
like the average of GPT's "crypto Twitter voice" — which is the
exact bot-class voice we're trying to escape.
