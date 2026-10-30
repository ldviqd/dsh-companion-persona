# Changelog

## 0.3.0

Mutation was effectively dead on real text. Fixed — and made deliberately hard
to trigger by accident.

### The bug (reported by an external audit, confirmed)

`novelty` was computed in `signals.js` from the **pre-calibration** valence, but
`calibrateValence()` runs later in `toEpisode()`. A plain betrayal carries no
sentiment words, so its raw valence is 0, so `novelty` collapsed to the short-
sentence floor of 0.15:

```
shock = |−0.85| × 0.382 × 0.15 = 0.0487     // threshold is 0.50
```

Measured: five consecutive betrayals pushed `load` to 1.38 while `shock` stayed
at 0.0487. **500 rounds of continuous harm produced zero mutations.** The single
most distinctive feature of the design never fired.

The bundled `selftest.js` could not see this because it drove `step()` with
hand-built episodes that hard-code `novelty: 0.35`, never touching the signal
layer — the same mistake the CHANGELOG already recorded for v0.1.x.

### Why not just lower the threshold

The obvious fix — decouple `novelty` from `shock` and drop the threshold — makes
"you lied to me" score 0.32, so **two sentences flip the persona**. A bad
afternoon would rewrite months of accumulated character.

Instead the gate gained two dimensions:

**`trustDamage` — accumulated relationship damage**

| | `load` | `trustDamage` |
|---|---|---|
| means | rough patch | this person hurt me |
| decays | ×0.92 / turn | ×0.995 / turn (~140-turn half-life) |
| heals | one good night | needs sustained repair (repair rate is half the damage rate) |

**`MUTATE_MIN_EVENTS = 3` — independent negative events required**

This is the hard guarantee against "a few careless words": with `load`,
`sensitivity` and `trustDamage` all pinned at maximum, a single event still
cannot mutate. Verified by test.

### Also fixed: relevance was semantically wrong

`relevance` was derived from length, intimate-topic words and self-disclosure
only — so the four-character "你骗了我" scored 0.40, i.e. *this doesn't concern
us much*. Being betrayed by someone close is about as relevant as it gets.

Added `HIGH_RELEVANCE_KINDS` (betrayal / loss 0.85, intimacy 0.65, repair 0.60,
conflict 0.55). Short-sentence betrayal magnitude rises 0.41 → 0.61, shock 0.16 → 0.233.

### Recalibrated `MUTATE_SHOCK` 0.50 → 0.20

Real short sentences land at 0.16–0.23. Swept the threshold against real text:

| threshold | severe harm | mild complaints |
|---|---|---|
| 0.50 | never | never |
| **0.20** | **turn 6** | **never** |
| 0.15 | turn 7 | turn 13 ← dangerous |
| 0.08 | turn 7 | turn 13 |

0.20 is the only value where harm is reachable and complaints are not.

### Measured behaviour (real text driving the full chain)

| scenario | mutations | warmth Δ | guardedness Δ |
|---|---|---|---|
| 300 turns of small talk | 0 | 0.000 | 0.000 |
| 300 turns of mild complaints | 0 | −0.600 | +0.636 |
| 50 turns of severe harm | 1 (turn 6) | −0.451 | +0.278 |
| 300 turns of warm relationship | 0 | +0.254 | −0.100 |

300 turns of "I'm tired / a bit annoyed" wears the persona down but never flips
it. Six consecutive betrayals does.

### Panel

Shows mutation progress (`trustDamage` and negative-event count against their
thresholds) so it is visible *why* a persona has not mutated yet.

### Tests

`e2e.js` 23 → **30 assertions**, now including real-text mutation reachability
and defensive checks (mild complaints must not mutate; small talk must not move
traits at all). `selftest.js` assertions updated — "two blows must mutate" is
superseded by "no single event can mutate".

## 0.2.2

Addresses the v0.2.0 audit. Three functional defects, all verified by test.

### N1 — model judging never actually ran (high)

`judgeProvider` / `judgeModel` defaulted to empty strings, and those empty strings
were passed straight to `ctx.llm.stream()`, which throws `NO_ADAPTER` for an
unregistered provider. Every turn fell through to the rule fallback, so the
advertised 91% was really 68% — silently.

The judge now **inherits the current agent's model** (`agent.options.provider` /
`agent.options.model`), so switching models switches the judge automatically.
Explicit config still wins when you want to pin a channel. Documented in the
config table, where it was previously missing entirely.

### N2 — lost update on concurrent turns (high)

Judging became async, so `turn/end` handlers could overlap: two turns both read
the shared `state` snapshot, and the later write clobbered the earlier one.
Reproduced with 30ms/5ms delays — only one turn's effect survived. State updates
now run through a serial promise chain (same pattern as `persistChain`).
0.1.x had no such race because it was fully synchronous.

### Bond channel was unreachable, so good relationships never warmed (high)

`BOND_THRESHOLD = 0.30` filtered out **every real warm event**:
"谢谢你陪我" 0.226, "你真好" 0.170, "我今天升职了" 0.202, repair 0.202. Only
"我很喜欢你" (0.399) ever passed. A user who was consistently kind saw zero
change after 200 turns; the persona could only move in the negative direction.

Admission is now by **event kind** (`support` / `intimacy` / `repair` /
`achievement`) with a low 0.05 floor that only filters noise. Magnitude decides
*how much* to move, not *whether* to move.

Measured: 200 warm turns → `warmth +0.212`, `guardedness −0.071`.

### Fallback path quality

The degraded path scored 68% and made directional errors: "我其实很害怕"
(vulnerability — a high-value intimacy signal) was classified as `conflict`
(negative valence), so a user opening up made the persona more guarded.

Fallback now orders: explicit conflict phrasing → intimate topics → vulnerability
expressions → positive hints → negative hints → repair → routine. 69% → **77%**,
and no intimacy case maps to a negative kind.

### Tests

`src/e2e.js` gained the two assertions whose absence let these through:

- **positive channel**: 200 warm turns must raise `warmth` by > 0.02
- **fallback accuracy**: a deliberately-broken classifier must still score ≥ 60%

The old "accuracy" check only counted rule-covered items and skipped everything
routed to the LLM — which is exactly how a permanently-failing judge went
unnoticed.

### Minor

- cache is now a real LRU (was FIFO while calling itself LRU)
- dropped `再见` / `拜拜` / `在吗` from the silent-word table — a farewell or a
  "are you there?" opener can be significant; they should not be zero-cost routine
- removed dead `cwdCmp` code in the exclusion check

## 0.2.1

- Fix: `@deepseek-ai/dsh-home-paths` was imported statically but never declared
  as a dependency, so a fresh `npm install` crashed on load with
  `Cannot find package`. It is now an **optional peer dependency** resolved at
  plugin start; if absent, the state path falls back to `$DSH_HOME` / `~/.dsh`.
  (It has no stable release on npm — only `rc`/`alpha` tags — so pinning it as a
  regular dependency would break installs.)

## 0.2.0

Signal layer rewritten. The old rule-only extractor scored **45%** on a 22-item
hand-labelled set of real Chinese utterances; the new layered judge scores **91%**.

### Why

Measured on 40 everyday utterances, the old rules classified **85% as `distance`**
(a negative event) — "嗯", "好的", "晚安", "早" all accumulated strain. Over 200
turns of ordinary chat this drove `warmth` down 0.41. A person having a normal
conversation was being worn into a different character.

Separately, `routine` events capped at magnitude 0.109, below the 0.30 bonding
threshold, so the "calm relationships warm slowly" design never actually ran.

### Layered judging (`src/judge.js`)

1. **Confident rules** — literal-meaning phrases (betrayal / loss / repair /
   explicit conflict / explicit distance) resolve at zero cost.
2. **Silent words** — pure acknowledgements (嗯/好的/晚安/哦…) map to `routine`
   instead of `distance`. Short replies are not withdrawal.
3. **LLM judging** — everything else, with an LRU cache. On failure it degrades
   to the old rule path, so the persona keeps working during rate limits.

Accuracy: 20/22. LLM calls: 12/22 (10 resolved by rules).

### Calibration fixed

`DRIFT_RATE` 0.12 → 0.03. The old value reached the trait floor after ~30
conflict turns; now 75 turns of relentless conflict lands at `warmth 0.16` — a
person worn down, not flattened.

### Bugs fixed

- `rest()` was imported but **never called**, so load saturated at 1.5 and
  sensitivity at 1.0 — the cusp fold degraded to "any shock ≥ 0.5 mutates".
  Idle recovery now runs in the turn handler.
- `describeChangesForPanel()` returned an array that callers destructured as an
  object, so the panel's "compared to before" was permanently empty.
- `toEpisode()` returned raw parameters instead of an appraised episode;
  passing it straight to `step()` produced `load: NaN`, which silently poisons
  all comparisons.
- Windows workspace exclusion only matched the exact root: `D:\a\b\sub` was
  not excluded by `D:\a\b`. Separators and case are now normalised.
- `maxChars` truncation cut the trailing "never describe your own personality"
  instruction first — the one line that prevents caricature. Truncation now
  preserves it at any budget.
- Mutation branch appended to `history` without the `.slice(-500)` the normal
  path uses.
- Panel read `data.turns`, which the server never returned.
- RPC fence accepted an empty `Host` header and never checked `Origin`.
- Removed `appendLedgerSync` (returned a Promise despite its name); use the
  host's `dsh-home-paths` instead of hand-building the data directory.

### Testing

New `src/e2e.js` drives real Chinese text through the full signal → dynamics
chain. The old `selftest.js` used an idealised event table and never touched
`signals.js` — which is how a 45%-accurate extractor shipped with a README
claiming "no visible change for 30 turns" while real text hit the floor in 15.

## 0.1.1

- Fix: `@deepseek-ai/schemastery` moved from `peerDependencies` to `dependencies`.
  As a peer, a fresh `npm install` left it unresolved and the plugin failed to load.
- Add `repository`, `homepage`, `bugs` metadata.

## 0.1.0 — 2026-10-29

First public version.

### Persona dynamics

- Five persistent traits (`warmth`, `volatility`, `guardedness`, `playfulness`,
  `dependence`), separate from any relationship/mood layer.
- Three evolution channels:
  - `drift` — chronic change, gated by accumulated load (`load > 0.55`)
  - `bond` — gradual warming from positive events, **not** gated by load
  - `mutation` — cusp catastrophe requiring shock + load + sensitivity simultaneously
- Per-axis resistance with near-boundary saturation, so a heavily-changed trait
  stops responding smoothly instead of sticking to a wall.
- Mutation cooldown after a rewrite, so one bad stretch can't cascade.

### Signal extraction

- Rule-based (no LLM call per turn) — works without network, costs nothing,
  never goes silent on rate limits.
- Event classification: `betrayal`, `loss`, `conflict`, `distance`, `repair`,
  `support`, `intimacy`, `achievement`, `routine`.
- Valence floor per event type. Word-list sentiment can raise it, never lower it —
  without this, plain conflict accumulates no load and the persona never changes.

### Expression

- Renders **changes relative to baseline**, never absolute trait values.
- Behavioural description only ("keeps things locked up"), no personality labels.
- Changes below the 0.06 perception threshold are omitted.
- Explicit instruction forbidding self-description.

### Injection

- Scoped system-prompt section via `agent.ctx.systemPrompt.section()` — read as
  identity, not as a user message.
- Rendered at assembly time, so changes apply on the next turn without restart.
- Backfills sections onto agents that already existed when the plugin loaded.

### Panel

- Trait bars with baseline tick marks.
- Live preview of the exact injected text.
- Identity editor (its name, what it calls you) — no restart needed.
- Two independent switches: inject / keep evolving. No reset button, by design.
- Conversation exclusions by workspace, session, or preset, with dropdowns populated
  from the live instance. Subagents always excluded.
- Change timeline with original user message as evidence.

### Persistence

- `state.json` via atomic write (temp file + rename).
- `ledger.jsonl` append-only timeline.
- Forward-compatible state loading: missing fields are filled with defaults.

### Known limitations

- Rule-based sentiment misses irony and restrained expression.
- Relationship state layer not implemented.
- Narrative self-model and memory-anchor recall not implemented.
