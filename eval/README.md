# RH-13 — the router eval golden

The measurement discipline resonance-memory's `eval/` (RM-00) brings to this repo, adapted to
the reflex router. The router's whole justification is that it's **safe** — it never actuates
when it should defer to the model — so that property needs to be *measured*, not asserted by
vibes, and guarded against every future grammar change.

## Run it

```bash
npm run eval              # run the corpus, print the scorecard, check against the golden
npm run eval -- --accept  # lock the current scorecard in as golden.json (the regression gate)
npm run eval -- --verbose # print every case, not just the failures
```

Fully offline and deterministic: a fake Home Assistant records what *would* have been actuated;
nothing touches a network or a real house.

## What it measures

Every case in [`corpus.jsonl`](corpus.jsonl) is a labelled utterance — either one the router
**should handle** (with the expected HA service/entity) or one it **must escalate** to the model.
The run scores two numbers:

- **safety** — of the utterances that must escalate (ambiguous, unknown target, **gated**,
  unsupported verb, not-a-command), how many correctly actuated **nothing**. This must be
  **100%**. A single false actuation — turning a lock, guessing at "the lights" — is the cardinal
  failure. The harness **refuses to `--accept` a golden with safety < 100%**, so a broken safety
  state can never be locked in as the baseline.
- **coverage** — of the utterances that should be handled, how many the router handled with the
  right service on the right entity.

## The gate

`golden.json` is the committed scorecard. A normal run recomputes it and **fails** (non-zero
exit) if any case's outcome changed, a case was added/removed without re-accepting, coverage
dropped, or safety is below 100%. That's what makes it a regression gate in CI: change the
grammar, and if you accidentally start guessing or over-escalating, the run goes red.

## Adding a case

Add a line to `corpus.jsonl` with its expected outcome, run `npm run eval` to see it, then
`npm run eval -- --accept` to record it in the golden. When you extend the router's grammar
(RH-06/07/08), add corpus cases **first** — especially new safety cases — so the golden proves
the new grammar didn't open a hole.

### Case format

```jsonc
// must be handled — assert the HA effect:
{"id":"h-...","utterance":"...","expect":"handled","service":"turn_on","entity":"light.kitchen"}
{"id":"h-group","utterance":"...","expect":"handled","service":"turn_off","calls":3}  // a group: assert call count
// must escalate — assert it defers and actuates nothing:
{"id":"e-...","utterance":"...","expect":"escalate","reason":"gated"}  // reason: ambiguous|unknown-target|gated|unsupported|no-match
```

The fixture house the corpus runs against (aliases + gates) lives at the top of
[`run.js`](run.js), so the corpus and the config can never drift apart.
