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

## The three verbs

| Verb | What it does |
|---|---|
| `get_home_state({ query? })` | A plain-language snapshot of lights, switches, thermostat, locks, doors/windows, covers. Read-only. `query` narrows it (`"windows"`, `"downstairs"`). |
| `set_devices({ changes })` | Apply a batch of changes: `{ target, state?/temperature?/brightness?, confirm? }`. Gated devices refuse without `confirm:true`. |
| `run_routine({ name })` | Run a household-defined routine (`"bedtime"`, `"leaving"`). Baked once by a human; a weak model gets orchestration for free. |

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

## Status

Early (`v0.1`). The core (three verbs, alias resolution, safety gates, routines) is built and
tested against a fake Home Assistant. Next: a setup panel for token + aliases, real-HA smoke
testing, and covers/scenes polish. Same stack as Resonance Memory — **pure Node standard library,
zero runtime dependencies, MCP over stdio.**

## License

GPL-3.0 — see [`LICENSE`](LICENSE).

*Made by the Architect of Resonance.*
