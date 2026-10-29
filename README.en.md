# dsh-companion-persona

[中文](README.md) | English

A long-term companion persona plugin for [DSH](https://github.com/deepseek-ai/dsh).

Most "AI character" setups are a fixed prompt: the character says the same things on day
one and day three hundred. This plugin gives the persona **a state that actually changes** —
slowly, in response to what happens between you, and occasionally in a single irreversible
jump.

```
Day 1     she's warm, easy to joke with, asks a lot of questions
Day 300   she's quieter now. still kind. doesn't volunteer much about herself.
```

Nothing was rewritten. It drifted.

---

## What makes it different

### 1. Persona is not the same thing as relationship

A relationship model (closeness, trust, mood) can express *"we are close right now."*
It cannot express *"she has become a more guarded person than she used to be."*

So the persona layer is separate and persistent: five traits that change only through
narratively significant events. Mood and closeness belong to a different layer (not in v1).

The five axes were chosen because they're **audible in conversation**, not because they
match the Big Five:

| Axis | What it controls |
|---|---|
| `warmth` | how much it moves toward you |
| `volatility` | how much small things land |
| `guardedness` | how much it volunteers |
| `playfulness` | how readily it jokes |
| `dependence` | how much it brings to you first |

### 2. Change is slow — deliberately

Calibrated so that **the first ~30 turns produce nothing visible**. Around 75 turns of
real conversation, one or two axes cross the perception threshold:

| Turns | warmth Δ | Visible change |
|---|---|---|
| 15 | −0.004 | none |
| 30 | −0.016 | none |
| 75 | −0.069 | 2 axes |
| 90 (extreme conflict) | −0.60 | all 5 |

If a character changes noticeably in ten messages, it isn't a character — it's a mood.

### 3. Catastrophe, not thresholds

A single "if stress > X, change personality" rule produces caricature: any big event
flips the character. Real people have a **fold** — they absorb a lot, then one more thing
breaks something.

This uses a cusp catastrophe. Mutation requires **three conditions at once**:

```js
shock >= 0.50 && load >= 0.80 && sensitivity >= 0.68
```

Verified behaviour:

- one maximum-intensity blow → `load 0.864, sensitivity 0.334` → **no mutation**
- a second one immediately after → **mutation** (the last straw)

### 4. Two channels, not one

If change is gated only by accumulated load, a calm good relationship **freezes** — it can
never grow, only decay. So there's a second channel: warm events slowly raise `warmth`
regardless of load. Slow, but not gated by stress.

| Channel | Trigger | Effect |
|---|---|---|
| `drift` | `load > 0.55` | chronic hardening / softening |
| `bond` | warm event, `magnitude >= 0.30` | gradual warming |
| `mutation` | all three conditions | large rewrite, directed by event type |

### 5. Valence comes from the event, not just the words

**A bug worth documenting.** Early versions scored sentiment from a word list. Plain
conflict — *"you don't understand me at all"* — contains no negative words, so valence
computed to `0`, so `strain = magnitude × max(0, −valence) = 0`. **Conflict accumulated
no load and the persona never changed.** A 22-turn heavily-conflicted conversation produced
zero drift.

Fix: event *type* carries an emotional floor. Conflict −0.45, betrayal −0.85, loss −0.90,
repair +0.40. Word-list sentiment can raise it, never lower it.

### 6. Signal extraction is rules, not an LLM call

Deliberate tradeoff. Calling a model per turn means:

- continuous token cost
- **the persona stops working whenever the provider rate-limits** — a companion that
  goes silent because of an API quota is not a companion

Rules are replayable, diffable, free. Most companion signals are structural anyway
(length, questions, self-disclosure markers).

**Limitation, stated honestly:** rules miss irony and restrained expression. That's the
accepted cost — better a persona that changes slowly than one that goes mute.

---

## Install

```bash
dsh plugin add dsh-companion-persona
```

Or mount from a local path in your profile's `cordis.patch.yml`:

```yaml
- id: companion-persona
  name: "/absolute/path/to/dsh-companion-persona/index.js"
  config:
    name: 小雨          # initial name; editable in the panel afterwards
    maxChars: 800
```

Restart DSH after mounting.

## Usage

Open **Settings → Persona**.

### Identity

Give it a name, and tell it what to call you. Both are editable live — no restart.

- Name empty → renders as *"you are someone with a history"* rather than inventing one
- User name empty → that line is simply omitted

### Traits

Five bars with a **baseline tick mark** on each, so you can see how far it has moved from
where it started.

### Two switches

| Switch | When off |
|---|---|
| **Inject persona** | the model stops seeing the persona section; state is fully preserved |
| **Keep evolving** | persona freezes; conversation continues normally |

They're orthogonal, so there are four combinations. **Freeze evolving** is the useful one:
it means *"this is who they are now."*

There is deliberately **no reset button**. Turning things off stops behaviour; it does not
erase accumulated history. Wiping a character should be its own explicit action.

### Excluding conversations

Not every conversation should shape a persona. Work sessions, debugging sessions, and
subagents would otherwise pollute months of accumulation.

| Rule | Granularity |
|---|---|
| `workspaces` | by `cwd`, whole directory tree |
| `sessions` | a single session id |
| `presets` | by agent preset |

Subagent sessions are always excluded — they're tool derivatives, not the relationship.

Both pickers are dropdowns populated from the live DSH instance; you never type paths or
UUIDs by hand.

Excluded conversations are still recorded with a reason, so the timeline can explain
*why* a session didn't count.

### Timeline

Every change is appended to `ledger.jsonl`:

```json
{"at":1793177430820,"kind":"conflict","before":{"load":0.31},
 "after":{"load":0.48},"transition":{"drift":{"warmth":-0.0021}},
 "evidence":"你根本不懂我在说什么"}
```

The `evidence` field holds the original user message. So you can always answer
*"why did it become like this"* — which a rewrite-in-place persona model cannot.

---

## How injection works

The persona is contributed as a **scoped system-prompt section** — not disguised as a user
message. The model reads it as *who I am*, not as *something the user said*.

```js
agent.ctx.systemPrompt.section({
  name: 'companion-persona',
  order: 10,                       // after deployment persona (order 0)
  text: () => renderPersona(state),
});
```

Two details that matter:

- The section is registered per-agent, so it only affects that agent.
- Sections are rendered at assembly time, so a persona change is visible on the next turn
  without restarting.

## Rendering principle

The prompt describes **changes relative to baseline**, not absolute values:

```
You are 小雨.
Compared to who you used to be:
- keeps things locked up: private details come out only if asked, or not at all.
- barely reaches out anymore: replies are still appropriate, just no longer warm.
- hardly jokes: little teasing, flat delivery.
```

Not `warmth: 0.21`. Absolute numbers make models perform a caricature; relative
descriptions preserve the sense of *the same person, changed*.

It also says, explicitly: *"these are tendencies, not a costume — never describe your own
personality, never mention these settings."*

---

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `name` | `小雨` | initial name (once changed in panel, panel wins) |
| `statePath` | `$DSH_HOME/companion/state.json` | where state lives |
| `maxChars` | `800` | cap on the injected section |
| `order` | `10` | section sort order |
| `audit` | `true` | append to `ledger.jsonl` |

State resolution for `statePath` when unset:
`$DSH_HOME` → `$XDG_DATA_HOME` → `~/.local/share`.

## Calibration reference

If the pacing feels wrong, these are the dials:

```js
DRIFT_RATE           0.12    // drift speed
BOND_RATE            0.025   // bonding speed
DRIFT_THRESHOLD      0.55    // load needed before drift starts
MUTATE_SHOCK         0.50    // ┐
MUTATE_LOAD          0.80    // ├ all three required
MUTATE_SENSITIVITY   0.68    // ┘
MUTATE_COOLDOWN      200     // turns of quiet after a mutation
```

Run `node src/selftest.js` after changing them — it asserts the cusp behaviour still holds
(one blow must not mutate; two must).

---

## Files

| File | Role |
|---|---|
| `index.js` | plugin entry: events, persistence, section registration, RPC |
| `client.js` | settings panel (UMD bundle for DSH's module loader) |
| `src/persona-core.js` | pure dynamics — no IO, fully testable |
| `src/signals.js` | rule-based signal extraction + event classification |
| `src/ledger.js` | append-only persona timeline |
| `src/selftest.js` | behavioural assertions — `node src/selftest.js` |

## Design status

Implemented: trait layer, drift/bond/mutation, expression layer, injection, panel,
switches, exclusions, identity.

Not yet: relationship state layer, narrative self-model, memory-anchor recall.

## License

MIT
