# Changelog

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
