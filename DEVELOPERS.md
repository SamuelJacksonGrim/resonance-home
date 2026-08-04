# Resonance Home — developer notes

An MCP server that gives a small local LLM safe **hands** for a Home Assistant house — the
companion to [`resonance-memory`](https://github.com/SamuelJacksonGrim/resonance-memory)'s
**memory**. Pure Node standard library + built-in `fetch` (Node 18+), no SDK. Speaks MCP over
stdio as line-delimited JSON-RPC 2.0. It is **two-tier**: a deterministic **reflex router**
(fast, no model) beside the model's **cognitive** path (slow, reasoning). The house config and
`home-core` are the **substrate**; the model only ever sees three verbs and friendly names.

This file is the condensed version; [`CLAUDE.md`](CLAUDE.md) is the fuller one.

## Files

| File | What it is |
|---|---|
| `server.js` | The MCP server. Three verbs: `get_home_state`, `set_devices`, `run_routine`. Reads the version from `package.json` so `serverInfo` can't drift. |
| `home-core.js` | **The substrate.** `createCore({ ha, config })` → `{ getHomeState, setDevices, runRoutine }`; also exports the shared `resolveAlias` / `resolveService` / `domainOf`. All house knowledge and all safety live here. |
| `router.js` | **The reflex layer.** `createRouter({ core, config })` → `{ handle(utterance) }`. Deterministic grammar over the shared alias registry; executes safe commands, **fails open** on any uncertainty. Has an offline dry-run CLI. |
| `ha-client.js` | The Home Assistant REST wrapper (`getStates` / `callService`) over built-in `fetch`. Knows nothing about aliases/gates. A fake stands in for it in tests. |
| `entry.js` | Mode dispatch (`--mcp`). Future modes (panel, installer) hang off here. |
| `test.js` | Dependency-free suite: `npm test`. 25 tests, sub-second, against a fake HA. |
| `eval/` | **RH-13**, the router eval golden. `eval/run.js` scores `eval/corpus.jsonl` into safety + coverage and gates against `eval/golden.json`. |
| `home-config.example.json` | The house description to copy: aliases, gates, routines. |
| `system-prompt.md` | Optional copy-in system prompt for weaker models that forget to call tools. |
| `package.json` | No dependencies — scripts only (`test`, `eval`, `mcp`, `router`). Sole source of the version string. |

## Home Assistant & the substrate

- **REST only.** `GET /api/states` (every entity's state) and
  `POST /api/services/<domain>/<service>` (turn on, set temp…), long-lived-token auth. No
  websockets, no HA add-on. That is the whole integration surface, and it lives in `ha-client.js`.
- **The config is the house.** `home-config.json` (or `HOME_CONFIG_PATH`) defines `aliases`
  (friendly name → one `entity_id` or a group list), `gates` (`entity_id → "confirm" | "block"`),
  and `routines`. It is read **per call**, so editing it takes effect with no client restart.
- **`home-core` owns the mapping and the safety.** Friendly-name ↔ entity resolution
  (`resolveAlias`), the domain→service table (`resolveService`), and the gates all live here, so
  the MCP server and the router translate a name and enforce a gate through identical code.
- **Env vars:** `HA_URL` (default `http://localhost:8123`), `HA_TOKEN`, `HOME_CONFIG_PATH`.
- The embedder-free equivalent of resonance-memory's "embed once": **the model never touches an
  `entity_id`.** It speaks friendly names; the server resolves and actuates.

## The two tiers

- **Reflex** (`router.js`): `utterance → grammar → home-core → HA`, no model in the loop. On any
  uncertainty — no grammar match, unknown/ambiguous target, a gated device, an unsupported verb —
  it returns `{ handled:false, escalate:<reason> }` instead of guessing. It **never** actuates a
  gated device.
- **Cognitive** (`server.js`): `model → MCP verb → home-core → HA`. The model reasons over a
  fuzzy intent and composes `set_devices` itself.
- Both terminate in the **same** `home-core.setDevices`. One substrate, two callers — the same
  no-drift discipline as resonance-memory's `memory-core.js`.

## Test & eval (the two gates)

```
npm test                  # 25 tests against a fake HA — fast, dependency-free
npm run eval              # RH-13 router golden: safety (must be 100%) + coverage
npm run eval -- --accept  # lock the current scorecard in as eval/golden.json
npm run router -- "..."   # dry-run the reflex router offline (no HA needed)
```

- `npm run eval` scores a labelled utterance corpus into **safety** (of the utterances that must
  escalate, how many actuated nothing — must be 100%; the harness refuses to `--accept` below it)
  and **coverage** (of the utterances that should be handled, how many hit the right service).
- CI runs **both** on Node 18/20/22.

## Design invariants (do not violate)

The full statement is in [`CLAUDE.md`](CLAUDE.md). The load-bearing ones:

- **A small model cannot misuse it.** Friendly names and three verbs only — never a raw
  `entity_id`, never the wiring. The model assigns no metadata.
- **Safety gates live in code, not the prompt.** A gated entity refuses without `confirm:true`,
  and the **reflex router never actuates a gated device** — it escalates. A gate is code.
- **The reflex router never blocks — it fails open** to the model on any uncertainty.
- **One substrate, two callers.** Alias resolution and the service-mapping table live once, in
  `home-core.js`. Don't fork them into `router.js` or `server.js`.

## Where the work is planned

| Document | What |
|---|---|
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phased plan with a status vocabulary, a milestones table (v0.2 … v1.0), and an acceptance criterion on every `RH-` item |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Dev setup and the before-a-PR checklist |
| [`eval/README.md`](eval/README.md) | The router eval golden — how safety/coverage are scored and gated |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history (Keep a Changelog) |

Things a contributor should know before touching the code:

- **Nothing is `live` yet.** Everything is verified against a *fake* Home Assistant. `RH-01`
  (the live-HA smoke test) is the bottleneck that turns Phase 0 from **done** to **live** — it's
  the one step that needs a real HA + token.
- **Run `npm test` and `npm run eval` before pushing.** Both are dependency-free and instant; the
  eval's **safety** number must stay 100%.
- **Extending the router grammar?** Add corpus cases first — especially new *safety* cases — then
  `npm run eval -- --accept`. The golden is the proof the new grammar didn't open a hole.
- **Keep `home-core.js` the single implementation.** New alias/service logic goes there.

## Companion

This is one half of a pair. [`resonance-memory`](https://github.com/SamuelJacksonGrim/resonance-memory)
runs alongside it as a **second MCP server** so the model gains a persistent memory *and* a
house, with **zero coupling** between the repos — they compose at the client, not in code.
