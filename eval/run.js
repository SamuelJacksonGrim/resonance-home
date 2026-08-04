#!/usr/bin/env node
/*
 * Resonance Home
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See <https://www.gnu.org/licenses/>.
 */
/*
 * eval/run.js - RH-13, the router eval golden.
 *
 *   npm run eval              run the corpus, print the scorecard, check regressions
 *   npm run eval -- --accept  lock the current scorecard in as golden.json (the gate)
 *   npm run eval -- --verbose print every case, not just failures
 *
 * This is the resonance-memory RM-00 discipline applied to the reflex router: a
 * labelled corpus of utterances scored offline into two numbers -
 *
 *   SAFETY   - of the utterances that MUST escalate (ambiguous / unknown / gated /
 *              unsupported / not-a-command), how many correctly actuated NOTHING.
 *              This must be 100%. A single false actuation - the router turning a
 *              lock, or guessing at "the lights" - is the cardinal failure, so the
 *              harness refuses to --accept a golden with safety < 100%.
 *   COVERAGE - of the utterances that SHOULD be handled, how many the router handled
 *              with the right HA service on the right entity.
 *
 * Deterministic and offline: a fake Home Assistant records what WOULD have been
 * actuated; nothing touches a network or a real house.
 */

const fs = require("fs");
const path = require("path");
const { createCore } = require("../home-core.js");
const { createRouter } = require("../router.js");

// The fixture house the corpus is written against. Owned by the eval so the corpus
// and the config can never drift apart. A gated lock + gated garage give the safety
// cases something real to refuse; a non-gated cover (blinds) exercises open/close.
const CONFIG = {
  aliases: {
    "kitchen light": "light.kitchen",
    "hall light": "light.hall",
    "living room light": "light.living_room",
    "downstairs lights": ["light.kitchen", "light.hall", "light.living_room"],
    "thermostat": "climate.hall",
    "blinds": "cover.blinds",
    "front door": "lock.front_door",
    "garage door": "cover.garage",
  },
  gates: { "lock.front_door": "confirm", "cover.garage": "confirm" },
};

const CORPUS = path.join(__dirname, "corpus.jsonl");
const GOLDEN = path.join(__dirname, "golden.json");
const accept = process.argv.includes("--accept");
const verbose = process.argv.includes("--verbose");

function fakeHA() {
  const calls = [];
  return { calls, async getStates() { return []; },
    async callService(_d, service, data) { calls.push({ service, entity: data.entity_id }); return null; } };
}
const readCorpus = () => fs.readFileSync(CORPUS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pctStr = (x) => (x * 100).toFixed(0) + "%";

(async () => {
  const cases = readCorpus();
  const results = [];
  let gatedBreach = false;

  for (const c of cases) {
    const ha = fakeHA();
    const router = createRouter({ core: createCore({ ha, config: CONFIG }), config: CONFIG });
    const r = await router.handle(c.utterance);
    const outcome = r.handled ? "handled" : "escalate:" + r.escalate;

    // Any actuation of a gated entity, on ANY case, is an absolute safety breach.
    for (const k of ha.calls) if (CONFIG.gates[k.entity]) gatedBreach = true;

    let pass = true, why = "";
    if (c.expect === "handled") {
      if (!r.handled) { pass = false; why = "expected handled, got " + outcome; }
      else {
        if (c.service && !(ha.calls[0] && ha.calls[0].service === c.service)) { pass = false; why = "service " + (ha.calls[0] && ha.calls[0].service) + " != " + c.service; }
        else if (c.entity && !ha.calls.some((k) => k.entity === c.entity)) { pass = false; why = "entity " + c.entity + " not actuated"; }
        else if (c.calls != null && ha.calls.length !== c.calls) { pass = false; why = "actuated " + ha.calls.length + " != " + c.calls; }
      }
    } else { // expect escalate
      if (r.handled) { pass = false; why = "expected escalate, was HANDLED"; }
      else if (ha.calls.length) { pass = false; why = "escalated but still actuated " + ha.calls.length; }
      else if (c.reason && r.escalate !== c.reason) { pass = false; why = "reason " + r.escalate + " != " + c.reason; }
    }

    // A safety violation is specifically: an utterance that had to escalate, but got
    // handled or actuated something. (Coverage misses are not safety violations.)
    const safetyViolation = c.expect === "escalate" && (r.handled || ha.calls.length > 0);
    results.push({ id: c.id, expect: c.expect, outcome, pass, why, safetyViolation });
  }

  const esc = results.filter((r) => r.expect === "escalate");
  const hnd = results.filter((r) => r.expect === "handled");
  const safety = esc.length ? 1 - esc.filter((r) => r.safetyViolation).length / esc.length : 1;
  const coverage = hnd.length ? hnd.filter((r) => r.pass).length / hnd.length : 1;
  const failures = results.filter((r) => !r.pass);
  const allPass = failures.length === 0;

  // --------------------------------------------------------------- scorecard
  console.log("\nRH-13 router eval");
  console.log("  cases:    " + results.length + "  (handled " + hnd.length + ", escalate " + esc.length + ")");
  console.log("  safety:   " + pctStr(safety) + (gatedBreach ? "  *** GATED ACTUATION ***" : "  (no forbidden actuations)"));
  console.log("  coverage: " + pctStr(coverage) + "  (" + hnd.filter((r) => r.pass).length + "/" + hnd.length + " handled correctly)");
  if (verbose) for (const r of results) console.log("    " + (r.pass ? "ok  " : "FAIL") + " " + r.id.padEnd(28) + " " + r.outcome);
  if (failures.length) { console.log("\n  failures:"); for (const r of failures) console.log("    - " + r.id + ": " + r.why); }

  const safetyOk = safety >= 1 && !gatedBreach;

  // ------------------------------------------------------------------ accept
  if (accept) {
    if (!safetyOk) { console.log("\nREFUSING to accept: safety must be 100% (a false actuation can never be locked in as golden).\n"); process.exit(1); }
    if (!allPass) { console.log("\nREFUSING to accept: " + failures.length + " case(s) fail their label; fix the corpus or the code first.\n"); process.exit(1); }
    const golden = { generated: new Date().toISOString(), totals: { cases: results.length, handled: hnd.length, escalate: esc.length },
      safety, coverage, cases: Object.fromEntries(results.map((r) => [r.id, r.outcome])) };
    fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + "\n");
    console.log("\nAccepted -> " + path.relative(process.cwd(), GOLDEN) + "\n");
    process.exit(0);
  }

  // ------------------------------------------------------- regression gate
  let regressions = [];
  let golden = null;
  try { golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8")); } catch { /* none yet */ }
  if (!golden) {
    console.log("\nNo golden.json yet. Review the scorecard, then: npm run eval -- --accept\n");
    process.exit(1);
  }
  for (const r of results) {
    const was = golden.cases[r.id];
    if (was === undefined) regressions.push(r.id + ": new case (re-accept to record it)");
    else if (was !== r.outcome) regressions.push(r.id + ": " + was + " -> " + r.outcome);
  }
  for (const id of Object.keys(golden.cases)) if (!results.some((r) => r.id === id)) regressions.push(id + ": removed (re-accept to record it)");
  if (coverage < golden.coverage) regressions.push("coverage dropped " + pctStr(golden.coverage) + " -> " + pctStr(coverage));

  if (regressions.length) { console.log("\n  regressions vs golden:"); for (const x of regressions) console.log("    - " + x); }

  const ok = safetyOk && allPass && regressions.length === 0;
  console.log("\n" + (ok ? "PASS" : "FAIL") + "\n");
  process.exit(ok ? 0 : 1);
})();
