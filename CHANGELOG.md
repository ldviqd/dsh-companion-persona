# Changelog

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
