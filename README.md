# Resonance Home

**Give your local AI a house it can actually reason about — safely, and without leaving your machine.**

You tell it *"I'm going to bed"* and it turns off the downstairs lights, lowers the heating,
tells you the living-room window is still open, and leaves the front door alone unless you say
so. Not a wall of `IF-THEN` automations — a small local model *reasoning* over the real state of
your home, one intent at a time.

This is the **hands** to go with [Resonance Memory](https://github.com/SamuelJacksonGrim/resonance-memory)'s
**memory**. Run both as MCP servers in the same client (LM Studio, Claude Desktop, anything that
speaks MCP) and the model gains a persistent memory *and* a house — with no coupling between the
two: the model just uses both sets of tools.

## The idea

Same principle as Resonance Memory: **a small model cannot misuse it.**

- The model only ever sees **three verbs** and **friendly names** — `get_home_state`,
  `set_devices`, `run_routine`, and `"downstairs lights"` / `"front door"`. It never sees a raw
  `entity_id`, and it assigns none of the wiring.
- All the house-specific knowledge — which friendly name maps to which device, what's **gated**
  (a lock won't actuate without an explicit `confirm:true`), what a routine does — lives in a
  config file the **server** owns, not in the model's prompt.
- The model does the **reasoning** ("going to bed" → which primitives, in what order, what to
  report). The server provides **safe primitives** and **honest state**. No 500-rule tree, and no
  way for a confused 3B model to unlock your door.

Cheap by design: the reasoning is light enough for a small quantized model on a mini-PC or a
single budget GPU, because the hard part (device mapping, safety, state) is done in code, not by
the model.

## Architecture (the cheap "middle" everyone's looking for)

```
  You ──speak/type──▶  a small local LLM  ──MCP──▶  resonance-home  ──REST──▶  Home Assistant
                        (the reasoning)             (safe hands + state)        (the devices)
                              │
                              └────────────────MCP──▶  resonance-memory
                                                       (who's Sarah, how you like the heat)
```

- **Home Assistant** is the device backbone (free; runs on a Pi/mini-PC).
- **resonance-home** (this repo) exposes HA to the model as three safe verbs over stdio.
- **A small local model** does the intent reasoning.
- **resonance-memory** (optional) makes it feel like it knows *you*.

### Two tiers: a reflex layer and a cognitive layer

Running the full `Whisper → 30B → tool-call → HA → TTS` loop for *"turn on the kitchen
lights"* is overkill — and the latency is exactly what makes a local voice assistant feel
worse than Alexa. So control is split in two (System 1 / System 2):

```
  REFLEX  (fast)   Whisper ─▶ router.js ────────────▶ home-core ─▶ HA      (no model — instant)
  COGNITIVE (slow) Whisper ─▶ 30B ─▶ MCP server ────▶ home-core ─▶ HA ─▶ TTS  (model reasons)
```

- **`router.js`** is a deterministic grammar over the **same** alias registry and the
  **same** home-core the MCP server uses — one substrate, two callers. It handles the
  unambiguous, safe, single-intent commands (*"lights off"*, *"set the thermostat to 18"*)
  with **no model in the loop**.
- It **never blocks.** Anything uncertain — no grammar match, an unknown or **ambiguous**
  target (*"turn on the lights"* → which?), a **gated** device (a lock/garage), or a verb a
  device can't take — *fails open* and escalates to the 30B. A gated device is **never**
  reflex-actuated; the confirm flow belongs to the model.
- Alexa-speed for *"lights on"*; the 30B reserved for *"set the house up for cooking."*

Try the boundary yourself, offline, no Home Assistant needed:

```bash
npm run router -- "turn on the kitchen lights"   # REFLEX (no model)
npm run router -- "set the thermostat to 18"     # REFLEX (no model)
npm run router -- "turn on the lights"           # ESCALATE (ambiguous)
npm run router -- "unlock the front door"        # ESCALATE (gated/no-match — model owns it)
npm run router -- "set the house up for movie night"  # ESCALATE (no-match — real reasoning)
```

> The orchestrator that owns the mic wires these together: run each utterance through the
> router; if `handled`, speak the reply; if `handled:false`, hand `utterance` to the model.
> That orchestrator (Whisper + the LLM client) is the standard front-end you add around
> this — the router and the MCP server are the parts that live here.

## The three verbs

| Verb | What it does |
|---|---|
| `get_home_state({ query? })` | A plain-language snapshot of lights, switches, thermostat, locks, doors/windows, covers. Read-only. `query` narrows it (`"windows"`, `"downstairs"`). |
| `set_devices({ changes })` | Apply a batch of changes: `{ target, state?/temperature?/brightness?, confirm? }`. Gated devices refuse without `confirm:true`. |
| `run_routine({ name })` | Run a household-defined routine (`"bedtime"`, `"leaving"`). Baked once by a human; a weak model gets orchestration for free. |

## Requirements

- **Node.js ≥ 18** — that's the whole toolchain. **Zero runtime dependencies** (no `npm install`
  needed to run it; `package.json` has no `dependencies` block). Same rule as resonance-memory:
  the dependency-free property is deliberate.
- **A running Home Assistant** with a **long-lived access token** (Home Assistant → your profile
  → Security). This server talks to HA's REST API; HA itself runs free on a Pi/mini-PC.
- **An MCP client with a local model** — LM Studio, Claude Desktop, or anything that speaks MCP
  over stdio — for the cognitive path.
- **Optional, for voice:** a local STT (e.g. `whisper.cpp`) and a TTS on the front end. Those
  aren't in this repo — they're the standard orchestrator you wrap around the router + server
  (see the roadmap, `RH-04`).
- **Optional:** [`resonance-memory`](https://github.com/SamuelJacksonGrim/resonance-memory) as a
  second MCP server, so the model personalises with no coupling to this one.

## Setup

1. In Home Assistant, create a **long-lived access token** (your profile → Security).
2. Point this server at your HA and describe your house in a config file (see
   `home-config.example.json`) — friendly names, gates, routines.
3. Wire it into your MCP client to launch `resonance-home --mcp` with these env vars set:

```bash
HA_URL=http://homeassistant.local:8123     # your Home Assistant
HA_TOKEN=<your long-lived access token>
HOME_CONFIG_PATH=~/.resonance-home/home-config.json
```

```bash
npm test    # dependency-free suite (drives the core against a fake HA — no HA needed)
npm run mcp # run the MCP server on stdio
```

**Weaker models forgetting to use the tools?** The tool descriptions already tell the model
*when* to check state and act — but smaller local models sometimes forget, or actuate before
checking. [`system-prompt.md`](system-prompt.md) is an optional block you can paste into your
app's system prompt to remind it every turn (and to reinforce that gated devices are never
opened on a guess).

## Config (`home-config.example.json`)

```json
{
  "aliases": {
    "kitchen light":     "light.kitchen",
    "downstairs lights": ["light.kitchen", "light.hall", "light.living_room"],
    "thermostat":        "climate.hall",
    "front door":        "lock.front_door"
  },
  "gates": { "lock.front_door": "confirm" },
  "routines": {
    "bedtime":  [{ "target": "downstairs lights", "state": "off" }, { "target": "thermostat", "temperature": 17 }],
    "leaving":  [{ "target": "downstairs lights", "state": "off" }, { "target": "thermostat", "temperature": 15 }]
  }
}
```

- **`aliases`** — a friendly name → one `entity_id`, or a list (a group like "downstairs lights").
- **`gates`** — `"confirm"` (needs `confirm:true` to actuate) or `"block"` (never remotely
  controllable). Put your locks and garage door here.
- **`routines`** — named batches of changes, run by `run_routine`.

## Repository layout

| Path | Role |
|---|---|
| `server.js` | The MCP server — the three verbs over stdio (the cognitive path). |
| `home-core.js` | The substrate: alias resolution, service mapping, safety gates, routines. One implementation, called by both the server and the router. |
| `router.js` | The reflex layer — deterministic fast-path grammar + offline dry-run CLI. |
| `ha-client.js` | The Home Assistant REST wrapper (`getStates` / `callService`). |
| `entry.js` | Mode dispatch (`--mcp`). |
| `test.js` | The dependency-free test suite (25 tests). |
| `eval/` | The router eval golden (`RH-13`): a labelled utterance corpus scored into safety + coverage, gated by `golden.json`. |
| `home-config.example.json` | The house description to copy and edit. |

## Docs

- [`CLAUDE.md`](CLAUDE.md) — architecture, invariants, and conventions (for AI assistants and contributors).
- [`DEVELOPERS.md`](DEVELOPERS.md) — condensed developer notes (files, substrate, the two tiers, the gates).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev setup and the before-a-PR checklist.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phased plan with milestones (`RH-01` …).
- [`eval/README.md`](eval/README.md) — the router eval golden (safety + coverage).
- [`CHANGELOG.md`](CHANGELOG.md) — release history (Keep a Changelog).

## Status

Early (`v0.1`). Built and tested against a fake Home Assistant (25 tests, `npm test`):

- the three MCP verbs, alias resolution, safety gates, routines (`home-core.js` / `server.js`);
- the **reflex router** (`router.js`) — the fast-path layer, with its offline dry-run CLI.

Next: a setup panel for token + aliases, real-HA smoke testing, and covers/scenes polish. Same
stack as Resonance Memory — **pure Node standard library, zero runtime dependencies, MCP over
stdio.**

## License

GPL-3.0 — see [`LICENSE`](LICENSE).

*Made by the Architect of Resonance.*
