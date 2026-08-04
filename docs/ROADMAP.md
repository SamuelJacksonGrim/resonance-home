# Roadmap

Where Resonance Home is going, in rough order. Same north star throughout: **the cheapest
local setup that feels genuinely intelligent** — a small model reasoning over a real house —
without the interface ever getting more dangerous or more cognitively demanding. Sophistication
grows in the substrate; the model keeps seeing three verbs and friendly names.

Status legend: **done** · **next** · **planned** · **exploring**.

## Phase 0 — Core (done, `v0.1`)

- **RH-00 · The substrate + three verbs.** `home-core` (alias resolution, service mapping,
  gates, routines) behind `get_home_state` / `set_devices` / `run_routine`. **done**
- **RH-00b · Reflex router.** Deterministic fast-path grammar, fail-open escalation, offline
  dry-run CLI. **done**
- **RH-00c · Test harness.** 25 dependency-free tests against a fake Home Assistant. **done**

## Phase 1 — Make it real

- **RH-01 · Live-HA smoke test. (next)** Run against an actual Home Assistant: confirm
  `getStates`/`callService`, token auth, and the friendly-name mapping on real entities. Add a
  short, opt-in integration script (skipped when `HA_URL`/`HA_TOKEN` are unset) so `npm test`
  stays offline by default. *Acceptance: bedtime + leaving flows actuate real devices; gated
  lock refuses without confirm.*
- **RH-02 · Setup panel.** A local `127.0.0.1` control panel (mirroring resonance-memory's
  Connect panel): paste the HA URL + token, auto-discover entities, and build the alias/gate
  config by clicking rather than hand-editing JSON. *Acceptance: a non-technical user gets a
  working `home-config.json` without opening an editor.*
- **RH-03 · Install into MCP clients.** Detect and wire into LM Studio / Claude Desktop MCP
  config (preserve other servers, leave a `.bak`) — same shape as resonance-memory's installer.

## Phase 2 — The voice orchestrator (the two-tier loop, end to end)

- **RH-04 · Reference orchestrator.** The mic-owning front end that ties the tiers together:
  `Whisper (STT) → router → [handled ? speak : escalate to the LLM] → TTS`. Ships as a small
  reference app, not baked into the server. *Acceptance: "lights on" round-trips at reflex
  speed; "set up the house for cooking" round-trips through the model.*
- **RH-05 · Latency pass.** Streaming/low-latency STT on the reflex path (Whisper is the floor
  once the model is bypassed). Measure and publish the reflex vs. cognitive round-trip numbers.

## Phase 3 — A richer reflex, still safe

- **RH-06 · Relative + scene commands.** "warmer", "dim a bit", "brighter", "a little cooler" —
  read current state, apply a bounded delta. Still deterministic, still fail-open.
- **RH-07 · Per-room / contextual targets.** Resolve "the lights" against the room the command
  was spoken in (area context), turning today's *ambiguous → escalate* into a confident reflex
  where the context makes it unambiguous.
- **RH-08 · Multi-intent utterances.** Split "lights off and lock up" into a batch the router
  can partially handle (reflex the lights) and partially escalate (the gated lock).

## Phase 4 — The "feels intelligent" layer

- **RH-09 · State-aware reporting.** The OP's "…and tell me if anything looks unusual": surface
  open windows / unlocked doors / left-on devices as part of a bedtime/leaving summary.
- **RH-10 · Modes.** Vacation / away / movie presets, with the model proposing and the user (or
  a gate) confirming the consequential ones.
- **RH-11 · Memory composition.** Document + harden the pattern where `resonance-memory` runs
  alongside this server so the model personalises ("how Samuel likes the heat", "who's Sarah")
  with zero coupling between the two repos. Explore household-shared memory.

## Phase 5 — Packaging

- **RH-12 · Single-file executable.** A Node SEA build (as in resonance-memory) so the server +
  panel ship as one per-platform binary with no Node install on the user's machine.

## Invariants these must never break

Carried from `CLAUDE.md`: friendly names only (never `entity_id`s to the model); gates in code,
not the prompt; the reflex router never blocks and never actuates a gated device; one substrate,
two callers. Any feature above that would violate one of these is wrong, however convenient.
