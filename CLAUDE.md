# CLAUDE.md

Guidance for AI assistants (Claude Code and others) working in this repository.

## What this is

**Resonance Home** is an MCP (Model Context Protocol) server that gives a small local LLM
safe **hands** for a [Home Assistant](https://www.home-assistant.io/) house — the companion
to [`resonance-memory`](https://github.com/SamuelJacksonGrim/resonance-memory)'s **memory**.
You tell the model *"I'm going to bed"* and it turns off the downstairs lights, lowers the
heating, tells you a window is still open, and leaves the locked door alone unless you say so.

The design is **two-tier** (System 1 / System 2):

- **Reflex layer** (`router.js`) — a deterministic grammar that handles the unambiguous, safe,
  single-intent commands (*"lights off"*, *"set the thermostat to 18"*) with **no model in the
  loop**. Alexa-speed.
- **Cognitive layer** (`server.js`, the MCP verbs) — the local LLM reasons over a fuzzy intent
  (*"set the house up for cooking"*) and calls the same substrate.

Both call **one** substrate (`home-core.js`): one alias registry, one service-mapping table,
one set of safety gates. The guiding principle, inherited from resonance-memory: **a small
model cannot misuse it.**

## Tech stack & constraints

- **Pure Node.js standard library + built-in `fetch`** (Node ≥ 18). Speaks MCP over stdio as
  line-delimited JSON-RPC 2.0.
- **Zero runtime dependencies.** `package.json` has no `dependencies` block. This is
  load-bearing — keep it dependency-free (it keeps the surface small and the test suite
  instant), same rule as resonance-memory.
- **CommonJS** (`"type": "commonjs"`), not ESM.
- **Home Assistant integration is REST only** — `GET /api/states` and
  `POST /api/services/<domain>/<service>`, long-lived-token auth. No websockets, no HA add-on.

## Repository layout

| File | Role |
|---|---|
| `entry.js` | Mode dispatch: `--mcp` (or no arg) → MCP server. Future modes (panel, installer) hang off here. |
| `server.js` | The MCP server. Declares the three verbs (`get_home_state`, `set_devices`, `run_routine`), wires the environment (HA client, per-call config load) into home-core, runs the JSON-RPC stdio loop. Reads the version from `package.json`. |
| `home-core.js` | **The substrate — one implementation, many callers.** `createCore({ ha, config })` → `{ getHomeState, setDevices, runRoutine }`. Also exports the shared `resolveAlias`, `resolveService`, `domainOf`, `REPORT_DOMAINS`. All house knowledge and all safety live here. |
| `router.js` | **The reflex layer.** `createRouter({ core, config })` → `{ handle(utterance) }`. Deterministic grammar over the shared alias registry; executes safe commands via home-core, **fails open** (escalate to the model) on any uncertainty. Has an offline dry-run CLI. |
| `ha-client.js` | The thinnest possible Home Assistant REST wrapper (`getStates` / `callService`) over built-in `fetch`. Knows nothing about aliases/gates — that's home-core's job. A fake stands in for it in tests. |
| `test.js` | The dependency-free suite (`npm test`). 25 tests, sub-second, driven against a fake Home Assistant. |
| `home-config.example.json` | The house description to copy: aliases, gates, routines. |
| `system-prompt.md` | Optional copy-in system prompt for weaker models that forget to call tools (or actuate without checking). Baked into the exe at `RH-12`. |
| `docs/ROADMAP.md` | Phased plan (`RH-01` …) with acceptance criteria. |
| `README.md` / `CHANGELOG.md` | User-facing overview / Keep-a-Changelog history. |

## Commands

```bash
npm test                              # full suite (node test.js) — fast, dependency-free
npm run mcp                           # run the MCP server on stdio (node server.js)
npm run router -- "turn on the lights"  # dry-run the reflex router offline (no HA needed)
```

## How it works (data flow)

- **Config** (`home-config.json`, or `HOME_CONFIG_PATH`) defines the house: `aliases`
  (friendly name → one `entity_id` or a group list), `gates` (`entity_id → "confirm" | "block"`),
  and `routines` (name → list of changes). It is read **per call**, so editing it takes effect
  with no client restart.
- **Cognitive path:** model → `server.js` verb → `home-core` → `ha-client` → Home Assistant.
- **Reflex path:** utterance → `router.js` → (on a clean match) `home-core.setDevices` → HA;
  otherwise `{ handled:false, escalate:<reason> }` so the orchestrator runs the model instead.
- **Env vars:** `HA_URL` (default `http://localhost:8123`), `HA_TOKEN`, `HOME_CONFIG_PATH`.

## Design invariants — DO NOT VIOLATE

1. **A small model cannot misuse it.** The model only ever sees **friendly names** and the
   three verbs — never a raw `entity_id`, never the wiring. It assigns no metadata.
2. **Safety gates live in code, not the prompt.** A gated entity refuses to actuate without an
   explicit `confirm:true`. The **reflex router never actuates a gated device at all** — it
   escalates, because the confirm flow belongs to the model. A gate is code, not a description
   the model can argue past.
3. **The reflex router never blocks — it fails open.** Every uncertainty (no grammar match,
   unknown/ambiguous target, gated device, unsupported verb) escalates to the model. The reflex
   layer is an *optimization*, never a gate on functionality.
4. **One substrate, two callers.** Alias resolution (`resolveAlias`) and the service-mapping
   table (`resolveService`) live once, in `home-core.js`. The router and the MCP server both
   call them. Never fork that logic into a second copy — that drift is exactly what the shared
   module exists to prevent (the same lesson as resonance-memory's `memory-core.js`).
5. **The server owns metadata; the config owns the house.** The model assigns none of it.

## Conventions

- **GPL-3.0 per-file header** tops every source file. Keep it on new files.
- **Comments carry the *why*, densely** — the bug avoided, the invariant a line protects, the
  reason a gate exists. Match that density.
- **Record the reasoning for a gate or a grammar rule** in a comment; a false-positive escalation
  is cheap (you just ran the model), a false-negative actuation is not.
- **Repo hygiene:** LF line endings (`.gitattributes`). User state (`home-config.json`, `.env`,
  backups) is gitignored; `home-config.example.json` is the tracked template.

## Before you push

- **Run `npm test`.** Dependency-free, sub-second. 25 tests; the router's fail-open and
  never-actuate-a-gate properties are regression-guarded there — keep them green.
- **A behaviour change isn't done until the docs change with it** — `README.md`, `CHANGELOG.md`,
  and `docs/ROADMAP.md`. Grep for what you changed.
- **Keep `home-core.js` the single implementation.** If you change alias resolution or the
  service mapping, change it there — do not fork a copy into `router.js` or `server.js`.
- Bump the version in `package.json` (the sole source of the version string) and record it in
  `CHANGELOG.md` when releasing.

## Git workflow

- Currently developed directly on `main` (solo, pre-release). Once it stabilises or others
  contribute, move to feature branches + PRs. Commit with clear messages; do not open a PR
  unless explicitly asked.
