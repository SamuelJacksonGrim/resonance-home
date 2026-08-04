# Changelog

All notable changes to Resonance Home are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims to follow
[Semantic Versioning](https://semver.org/). The public tool surface — the three verbs
`get_home_state` / `set_devices` / `run_routine` — is intended to stay stable; sophistication
grows in the substrate, not in the API.

## [Unreleased]

### Added
- **`system-prompt.md`** — an optional copy-in system prompt for weaker local models that
  forget to call tools, or actuate a device without checking the house first. Nudges the model
  to `get_home_state` before acting and to never actuate a gated device (lock/garage) on a guess.

## [0.1.0] — 2026-08-04

Initial scaffold: a two-tier, dependency-free MCP smart-home server.

### Added
- **MCP server** (`server.js`) exposing three safe verbs to a local LLM over stdio:
  `get_home_state` (read), `set_devices` (act), `run_routine` (named multi-step). The model
  sees only friendly names, never raw `entity_id`s.
- **The substrate** (`home-core.js`): friendly-name → entity resolution, the domain→service
  mapping table, safety **gates** (`confirm` / `block`), and routines. One implementation that
  both the MCP verbs and the reflex router call.
- **Home Assistant REST client** (`ha-client.js`): `getStates` + `callService` over built-in
  `fetch`, long-lived-token auth. Zero dependencies.
- **Reflex router** (`router.js`) — the fast-path tier of a two-tier (System 1 / System 2)
  design. A deterministic grammar that executes unambiguous, safe, single-intent commands with
  **no model in the loop**, and **fails open** (escalates to the LLM) on any uncertainty:
  no grammar match, unknown/ambiguous target, a **gated** device, or an unsupported verb.
  Gated devices are never reflex-actuated. Includes an offline dry-run CLI
  (`node router.js "turn on the kitchen lights"`).
- **Safety invariants**, inherited from resonance-memory: gates live in code (not the prompt);
  the reflex layer never blocks and never guesses; one substrate, two callers.
- **Test suite** (`test.js`): 25 dependency-free tests driven against a fake Home Assistant —
  the service mapping, state rendering, gate enforcement, routines, and every router
  handle/escalate path.
- **Docs**: `README.md`, `CLAUDE.md`, `docs/ROADMAP.md`, and `home-config.example.json`.

### Notes
- **No live-Home-Assistant validation yet.** Everything is verified against a fake HA client;
  real-HA smoke testing is the first item on the roadmap (`RH-01`).

[Unreleased]: https://github.com/SamuelJacksonGrim/resonance-home/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SamuelJacksonGrim/resonance-home/releases/tag/v0.1.0
