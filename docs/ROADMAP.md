# Roadmap

Where Resonance Home is going, in rough order. Same north star throughout: **the cheapest
local setup that feels genuinely intelligent** — a small model reasoning over a real house —
without the interface ever getting more dangerous or more cognitively demanding. Sophistication
grows in the substrate; the model keeps seeing three verbs and friendly names.

Every item below carries an **Acceptance** line — the concrete thing that has to be true for it
to pass. For **done** items it reads *(met)* and names the proof.

## Status vocabulary

What each tag means, roughly along the lifecycle. The one that matters most for this project is
the gap between **done** and **live**: almost everything is currently verified against a *fake*
Home Assistant, and nothing has been proven on a *real* house yet.

| Tag | Meaning |
|---|---|
| **live** | Shipped **and verified against a real Home Assistant** (for a doc/tool: validated in real use). The real bar. Nothing is here yet. |
| **done** | Built and passing tests, but **only against the fake-HA harness** — not yet validated live. Most of Phase 0 sits here. |
| **in progress** | Actively being built right now; partially landed. |
| **next** | The immediate next item to pick up. |
| **planned** | Accepted and specified, not started. |
| **exploring** | Being researched or designed; may change shape or be dropped. |
| **benched** | Built or specced, then deliberately **paused awaiting a dependency, decision, or measurement**. Not abandoned — will resume. |
| **shelved** | Deliberately set aside / deprioritized indefinitely. Kept for the record, off the near path. |

## Milestones (the finish line)

Which RH items make up each release, so "done" is a real destination, not an open horizon.

| Version | Theme | Items | Done when |
|---|---|---|---|
| **v0.1** | Core *(shipped)* | Phase 0 | Substrate, three verbs, reflex router, tests, docs — verified against a fake HA. |
| **v0.2** | "Real house" | RH-01, RH-13, RH-14, RH-15 | It runs reliably against a **real** Home Assistant, guarded by a safety golden, failing honestly when HA is down. **Phase 0 turns `live` here.** |
| **v0.3** | "One-click" | RH-02, RH-03, RH-17 | A non-technical user connects it without editing JSON or touching a terminal. |
| **v0.4** | "Voice" | RH-04, RH-05 | Mic → house works end to end, reflex-fast for simple commands. |
| **v1.0** | "Lives in the house" | RH-06, RH-07, RH-08, RH-09, RH-12 | Someone **other than the author** runs it daily as their smart-home voice assistant, installed from a single binary. |
| **post-1.0** | Exploring | RH-10, RH-11, RH-16 | — |

## Phase 0 — Core (`v0.1`)

- **RH-00 · The substrate + three verbs.** `home-core` (alias resolution, service mapping,
  gates, routines) behind `get_home_state` / `set_devices` / `run_routine`. **done**
  *Acceptance (met): `get_home_state` renders friendly names and drops non-home domains;
  `set_devices` routes each verb to the correct HA service and honours gates; `run_routine`
  executes every step — all asserted in `test.js`.*
- **RH-00b · Reflex router.** Deterministic fast-path grammar, fail-open escalation, offline
  dry-run CLI. **done**
  *Acceptance (met): every reflex hit executes exactly the right HA call(s) with no model in the
  loop; every ambiguous / unknown / gated / unsupported / no-match utterance escalates and
  actuates **nothing** (asserted per-case in `test.js`); `node router.js "…"` shows the same
  boundary offline.*
- **RH-00c · Test harness.** Dependency-free tests against a fake Home Assistant. **done**
  *Acceptance (met): `npm test` is green, offline, and sub-second; the router's fail-open and
  never-actuate-a-gate properties each have a test, so a regression flips one red.*
- **RH-00d · System prompt for weaker models.** The copy-in `system-prompt.md` that nudges a
  small model to check state before acting and never actuate a gated device on a guess.
  **in progress** — written and shipped as a paste-in file; what's left is baking it into the exe
  as a one-click copy (`RH-12`) and validating it against a real weak model, which is why it
  isn't **live**.
  *Acceptance: a model that ignored the tools starts calling `get_home_state` before acting once
  the block is pasted in.*

## Phase 1 — Make it real (and trustworthy)

- **RH-01 · Live-HA smoke test.** **next** — run against an actual Home Assistant: confirm
  `getStates`/`callService`, token auth, and the friendly-name mapping on real entities. Add a
  short, opt-in integration script (skipped when `HA_URL`/`HA_TOKEN` are unset) so `npm test`
  stays offline by default.
  *Acceptance: the bedtime + leaving flows actuate real devices; the gated lock refuses without
  `confirm:true`, actuates with it. This is the item that graduates Phase 0 from **done** to **live**.*
- **RH-13 · Router utterance corpus + scorecard.** **planned** — the RM-00 analogue for this
  repo: a labelled fixture of utterances (expected `handled` vs `escalate`, and for hits the
  expected target/change) scored offline, so a grammar tweak can't silently start guessing or
  over-escalating. Locked while the router is small, it guards `RH-06`/`RH-07`/`RH-08` before
  they exist. *(Sequenced ahead of the panel/installer on purpose: a safety golden is far cheaper
  to lock now than to retrofit after the grammar grows.)*
  *Acceptance: a corpus run prints two numbers — **safety** (never actuates when it should
  escalate; must be 100%) and **coverage** (handles what it should) — and a committed golden
  makes any regression fail the run, exactly like resonance-memory's `golden.json`.*
- **RH-02 · Setup panel.** **planned** — a local `127.0.0.1` control panel (mirroring
  resonance-memory's Connect panel): paste the HA URL + token, auto-discover entities, and build
  the alias/gate config by clicking rather than hand-editing JSON.
  *Acceptance: a non-technical user produces a working `home-config.json`, with at least one gate
  set, without opening a text editor.*
- **RH-03 · Install into MCP clients.** **planned** — detect and wire into LM Studio / Claude
  Desktop MCP config, same shape as resonance-memory's installer.
  *Acceptance: Connect adds an `mcpServers` entry launching `resonance-home --mcp`, preserves any
  other configured servers, and leaves a `.bak`; Disconnect removes only our entry.*
- **RH-17 · Config validation + entity discovery.** **planned** — validate `home-config.json` on
  load with clear, key-pointing errors instead of silently falling back to an empty house, and add
  a helper that dumps a live HA's entities (friendly name → `entity_id`) to bootstrap the aliases
  before the panel exists.
  *Acceptance: a malformed or unknown-entity config fails with a specific message naming the
  offending key; `resonance-home --entities` (or a small script) prints copy-pasteable alias lines
  from a live HA.*
- **RH-14 · Resilience: HA unreachable / partial failure.** **planned** — define and test what
  happens when Home Assistant is down mid-command or one entity in a group fails: the reflex path
  and the model path must both degrade honestly, never claim a change that didn't land.
  *Acceptance: with HA unreachable, `get_home_state` and `set_devices` return a clear error (not
  a crash, not a false success); a group where one entity fails reports exactly which succeeded
  and which didn't.*
- **RH-15 · Network + secrets hardening.** **planned** — this controls a house, so treat it that
  way: the panel binds `127.0.0.1` only, the HA token is never written to logs or the store, and
  config file permissions are sane.
  *Acceptance: no token string ever appears in stdout/stderr or any written file; the panel
  refuses non-loopback binds; a short doc note tells users where the token lives.*

## Phase 2 — The voice orchestrator (the two-tier loop, end to end)

- **RH-04 · Reference orchestrator.** **planned** — the mic-owning front end that ties the tiers
  together: `Whisper (STT) → router → [handled ? speak : escalate to the LLM] → TTS`. Ships as a
  small reference app, not baked into the server.
  *Acceptance: "lights on" round-trips at reflex speed (no model call); "set up the house for
  cooking" round-trips through the model; a single config points at both the STT and the LLM.*
- **RH-05 · Latency pass.** **planned** — streaming/low-latency STT on the reflex path (Whisper
  is the floor once the model is bypassed).
  *Acceptance: published reflex-vs-cognitive round-trip numbers on a named machine, with the
  reflex "lights on" path measurably and repeatably faster than the cognitive path.*

## Phase 3 — A richer reflex, still safe

- **RH-06 · Relative + scene commands.** **planned** — "warmer", "dim a bit", "brighter", "a
  little cooler": read current state, apply a bounded delta. Still deterministic, still fail-open.
  *Acceptance: a relative command reads current state and applies a delta clamped to configured
  min/max (never overshoots); an unparseable or unbounded one escalates; covered in the RH-13 corpus.*
- **RH-07 · Per-room / contextual targets.** **planned** — resolve "the lights" against the room
  the command was spoken in (area context).
  *Acceptance: with a room context supplied, "the lights" resolves to that room's lights as a
  confident reflex; with no context it still escalates as ambiguous (no regression to guessing).*
- **RH-08 · Multi-intent utterances.** **planned** — split "lights off and lock up" into a batch
  the router can partially handle (reflex the lights) and partially escalate (the gated lock).
  *Acceptance: the safe half actuates and the gated half escalates in one utterance; a partial
  failure never leaves the safe half unexecuted nor the gated half actuated.*

## Phase 4 — The "feels intelligent" layer

- **RH-09 · State-aware reporting.** **planned** — the OP's "…and tell me if anything looks
  unusual": surface open windows / unlocked doors / left-on devices in a bedtime/leaving summary.
  *Acceptance: the summary lists items that are genuinely open/unlocked/on from real state, and
  flags nothing that isn't.*
- **RH-10 · Modes.** **planned** — vacation / away / movie presets, with the model proposing and
  the user (or a gate) confirming the consequential ones.
  *Acceptance: selecting a mode applies its device set; every consequential step (lock, security)
  routes through a gate/confirm; the model proposes but never self-approves a gated action.*
- **RH-11 · Memory composition.** **exploring** — document + harden the pattern where
  `resonance-memory` runs alongside this server so the model personalises ("how Samuel likes the
  heat", "who's Sarah") with zero coupling between the two repos. Explore household-shared memory.
  *Acceptance: with both servers connected, the model personalises a home action from a stored
  memory (e.g. a preferred temperature) with no code path between the repos, via a documented,
  reproducible setup.*
- **RH-16 · Proactive monitoring / notifications.** **exploring** — the OP's "…notify me if
  anything important happens while I'm away." This is **outside MCP's pull-only** request/response
  model, so it belongs to a small watch loop in the orchestrator/daemon, not the verbs — a real
  architectural addition, flagged here so the original vision isn't quietly dropped.
  *Acceptance: a configurable watch delivers one real unsolicited notification (e.g. a door left
  unlocked after midnight) to a chosen channel, with the mechanism documented as separate from the
  MCP path.*

## Phase 5 — Packaging

- **RH-12 · Single-file executable.** **planned** — a Node SEA build (as in resonance-memory) so
  the server + panel ship as one per-platform binary with no Node install on the user's machine;
  the system prompt and example config are baked in.
  *Acceptance: one per-platform binary runs `--mcp` and the panel with no Node present; the baked
  system prompt is offered as a one-click copy; startup and size are comparable to
  resonance-memory's build.*

## Invariants these must never break

Carried from `CLAUDE.md`: friendly names only (never `entity_id`s to the model); gates in code,
not the prompt; the reflex router never blocks and never actuates a gated device; one substrate,
two callers. Any feature above that would violate one of these is wrong, however convenient.
