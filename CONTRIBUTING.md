# Contributing to Resonance Home

Thanks for looking. This is a small, deliberately simple project, and the goal is to keep it
that way: a local LLM that can operate a Home Assistant house, where **a small model cannot
misuse it**. Contributions that hold that line are very welcome.

## The one thing to internalise first

The whole design rests on a handful of invariants (spelled out in [`CLAUDE.md`](CLAUDE.md)).
The load-bearing ones:

- **The model only ever sees friendly names and three verbs** — never raw `entity_id`s, never
  the wiring. Sophistication grows in the substrate (`home-core.js`), not in the interface.
- **Safety gates live in code, not the prompt.** A gated device (a lock, a garage) never
  actuates without an explicit `confirm:true`, and the **reflex router never actuates a gated
  device at all** — it escalates to the model.
- **The reflex router never blocks — it fails open.** Any uncertainty escalates to the model.
- **One substrate, two callers.** Alias resolution and the service-mapping table live once, in
  `home-core.js`; both the MCP server and the router call them. Don't fork that logic.

A change that breaks one of these is wrong, however convenient. If you think an invariant
genuinely needs to change, open an issue and argue it first.

## Dev setup

There's nothing to install — **zero runtime dependencies**, Node ≥ 18.

```bash
git clone https://github.com/SamuelJacksonGrim/resonance-home
cd resonance-home

npm test                                # unit + regression suite (fake HA, sub-second)
npm run eval                            # RH-13 router golden (safety must stay 100%)
npm run router -- "turn on the lights"  # dry-run the reflex router offline
npm run mcp                             # run the MCP server on stdio
```

## Before you open a PR

1. **`npm test` and `npm run eval` are both green.** CI runs them on Node 18/20/22; a red run
   won't merge.
2. **If you touched the router grammar, add corpus cases *first*** — especially new *safety*
   cases (things that must escalate) — then `npm run eval -- --accept` to update the golden.
   The harness refuses to accept a golden with safety below 100%, by design.
3. **If you touched behaviour, update the docs that describe it** — `README.md`,
   `CHANGELOG.md` (under `[Unreleased]`), and `docs/ROADMAP.md` if it moves an item's status.
4. **Keep `home-core.js` the single implementation.** New alias or service-mapping logic goes
   there, not into a second copy in `router.js` or `server.js`.
5. **Keep it dependency-free.** No `dependencies` in `package.json` without a very strong,
   discussed reason.
6. **GPL-3.0 per-file header** on any new source file (see any existing `.js`).

## Commits & branches

Clear, imperative commit messages ("Add X", "Fix Y"). The repo is currently developed on
`main` (solo, pre-release); for anything non-trivial, a feature branch + PR is preferred so CI
and review can run. Please don't bundle unrelated changes into one PR.

## Scope & the roadmap

[`docs/ROADMAP.md`](docs/ROADMAP.md) lays out where this is going, with a status tag and an
acceptance criterion on every item. If you want to pick something up, the **next** and
**planned** items are the place to start — `RH-01` (live-HA smoke test) unblocks the most.
If you're proposing something new, saying which milestone it serves helps a lot.

## License

By contributing you agree your contribution is licensed under the project's **GPL-3.0-or-later**.
