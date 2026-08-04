#!/usr/bin/env node
/*
 * Resonance Home
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/*
 * router.js - the REFLEX layer of a two-tier (fast-path / slow-path) smart home.
 *
 * The problem this solves: a full Mic -> Whisper -> 30B -> tool-call -> HA -> TTS loop
 * is wonderful for "set the house up for cooking" but obnoxiously slow for "lights on".
 * So we split cognition in two, System 1 / System 2:
 *
 *   REFLEX (this file):  Whisper -> router -> home-core -> HA        (no model, instant)
 *   COGNITIVE (server):  Whisper -> 30B    -> MCP -> home-core -> HA (model reasons)
 *
 * The router is a DETERMINISTIC grammar over the SAME alias registry and the SAME
 * home-core the MCP server uses - one substrate, two callers (the exact pattern the
 * rest of this project is built on). It handles only the unambiguous, safe, single-
 * intent commands and hands EVERYTHING ELSE to the model.
 *
 * The one rule that keeps it from becoming the brittle IF-THEN tree it's meant to
 * replace: IT NEVER BLOCKS. Every uncertainty - no grammar match, an unknown or
 * ambiguous target, a gated device (a lock/garage), a verb the device can't take -
 * FAILS OPEN by returning { handled:false, escalate:<why> } so the orchestrator runs
 * the 30B instead. A reflex is an optimization, never a gate. In particular a gated
 * device is NEVER reflex-actuated: the confirm flow belongs to the model, so locks and
 * garage doors always escalate.
 *
 * handle(utterance) -> Promise<
 *     { handled:true,  reply, change, report }              // executed via home-core
 *   | { handled:false, escalate:<reason>, utterance, ... }  // hand to the 30B
 * >
 */

const { resolveAlias, resolveService, domainOf } = require("./home-core.js");

// Politeness / filler that a person says to a voice assistant but that carries no
// intent. Stripped before matching so "hey, could you turn on the hall light please"
// parses the same as "turn on the hall light".
const POLITE = /\b(please|thanks|thank you|thankyou|hey|okay|ok|yo|pls|could you|can you|would you|will you|i want to|i would like to|i'd like to|let's)\b/g;

function normalize(u) {
  return String(u || "").toLowerCase()
    .replace(/[^\w\s%]/g, " ")   // drop punctuation; keep word chars, whitespace, and %
    .replace(POLITE, " ")
    .replace(/\s+/g, " ").trim();
}

// Strip a leading determiner off an extracted target ("the kitchen light" -> "kitchen light").
function cleanTarget(t) { return String(t).replace(/^(?:the|my|a|an|all|some)\s+/, "").trim(); }

// Crude tokenizer + singularizer, applied SYMMETRICALLY to both alias names and the
// spoken target, so "kitchen lights" (spoken) and "kitchen light" (alias) reduce to the
// same token set. It doesn't matter that stripping a trailing 's' mangles a word
// ("downstairs" -> "downstair") because BOTH sides get mangled identically.
function toks(s) { return String(s).toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/s$/, "")); }
function subset(a, b) { for (const x of a) if (!b.has(x)) return false; return true; }

const pct = (n) => Math.max(0, Math.min(255, Math.round((+n / 100) * 255)));

/*
 * The grammar: ordered, most-specific first. Each entry pulls a { target, change }
 * out of the normalized utterance. `change` is exactly the shape home-core.setDevices
 * consumes, so a matched command flows straight through with no translation.
 *
 * Order matters: the "... to N percent" (brightness) rule must precede "... to N"
 * (temperature), or "set lamp to 50 percent" would be read as 50 degrees.
 */
const GRAMMAR = [
  { re: /^(?:set|dim|change|turn)\s+(.+?)\s+to\s+(\d+)\s*(?:%|percent|per\s*cent)\b/, build: (m) => ({ target: m[1], change: { brightness: pct(m[2]) }, say: m[2] + "%" }) },
  { re: /^(?:set|change|make|put|turn)\s+(.+?)\s+to\s+(\d+)\b/,                        build: (m) => ({ target: m[1], change: { temperature: +m[2] } }) },
  { re: /^(?:turn|switch|put|flip)\s+(on|off)\s+(.+)$/,                                build: (m) => ({ target: m[2], change: { state: m[1] } }) },
  { re: /^(?:turn|switch|put|flip)\s+(.+?)\s+(on|off)$/,                               build: (m) => ({ target: m[1], change: { state: m[2] } }) },
  { re: /^(open|close|shut|raise|lower)\s+(.+)$/,                                      build: (m) => ({ target: m[2], change: { state: /open|raise/.test(m[1]) ? "open" : "closed" } }) },
  { re: /^(.+?)\s+(on|off)$/,                                                          build: (m) => ({ target: m[1], change: { state: m[2] } }) },
];

/*
 * Fuzzy-match a spoken target against the alias registry by TOKEN SUBSET (either
 * direction), returning every distinct alias it could mean. Zero = unknown; more than
 * one = genuinely ambiguous ("the lights" -> every light). Both outcomes escalate; only
 * a lone, unambiguous match is ever executed by reflex.
 */
function matchAlias(aliases, phrase) {
  const tgt = new Set(toks(phrase));
  const out = [];
  for (const name of Object.keys(aliases)) {
    const a = new Set(toks(name));
    if (a.size && (subset(a, tgt) || subset(tgt, a))) out.push(name);
  }
  return out;
}

function ack(name, change) {
  if (change.temperature != null) return name + " set to " + change.temperature;
  if (change.brightness != null) return name + " brightness set";
  return name + " " + change.state;
}

/*
 * Build the reflex router over an injected home-core + config.
 *   core    a home-core instance (its setDevices actually actuates + re-checks safety)
 *   config  { aliases, gates } - the SAME house config the MCP server loads
 */
function createRouter({ core, config = {} }) {
  const aliases = config.aliases || {};
  const gates = config.gates || {};
  const esc = (reason, utterance, extra) => ({ handled: false, escalate: reason, utterance, ...(extra || {}) });

  async function handle(utterance) {
    const norm = normalize(utterance);
    if (!norm) return esc("empty", norm);

    let p = null;
    for (const g of GRAMMAR) { const m = norm.match(g.re); if (m) { p = g.build(m); break; } }
    if (!p) return esc("no-match", norm);            // not a simple command -> let the model reason

    const target = cleanTarget(p.target);
    const cands = matchAlias(aliases, target);
    if (cands.length === 0) return esc("unknown-target", norm, { target });
    if (cands.length > 1) return esc("ambiguous", norm, { target, candidates: cands });

    const name = cands[0];
    const ids = resolveAlias(aliases, name);
    // Safety pre-checks, reusing home-core's own gate map + service table. A gated
    // device (lock, garage) NEVER reflex-actuates; a verb the device can't take
    // (temperature on a light) is not a reflex command. Either way: escalate.
    for (const id of ids) {
      if (gates[id]) return esc("gated", norm, { target: name });
      if (!resolveService(domainOf(id), p.change)) return esc("unsupported", norm, { target: name });
    }

    // Clean, safe, unambiguous -> execute through home-core (which re-validates gates
    // and mapping, so the router can never be the thing that bypasses a safety check).
    const change = { target: name, ...p.change };
    const res = await core.setDevices([change]);
    // RH-14: never voice a cheerful "done" for a change that didn't land. If the actuation
    // failed (HA unreachable), report that honestly instead of the success ack.
    if (res.actuationFailed) {
      return { handled: true, ok: false, reply: "couldn't reach " + name + " — Home Assistant may be down", change, report: res.text };
    }
    return { handled: true, ok: true, reply: ack(name, p.change), change, report: res.text };
  }

  return { handle };
}

module.exports = { createRouter, normalize, matchAlias };

// --------------------------------------------------------------------- dry-run CLI
// `node router.js "turn on the kitchen lights"` - parse ONE utterance and print the
// decision without touching Home Assistant (a logging fake stands in for HA), so you
// can feel out the grammar and the escalate boundary offline. Loads your real house
// config if present, else the tracked example.
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const { createCore } = require("./home-core.js");
  const utter = process.argv.slice(2).join(" ");
  if (!utter) { console.log('usage: node router.js "turn on the kitchen lights"'); process.exit(0); }

  const configPath = process.env.HOME_CONFIG_PATH || path.join(__dirname, "home-config.example.json");
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { console.log("(no config at " + configPath + "; using empty)"); }

  const logHA = { calls: [], async getStates() { return []; }, async callService(d, s, data) { this.calls.push(d + "." + s + "(" + Object.entries(data).map(([k, v]) => k + "=" + v).join(",") + ")"); return null; } };
  const core = createCore({ ha: logHA, config });
  createRouter({ core, config }).handle(utter).then((r) => {
    if (r.handled) {
      console.log("REFLEX (no model)  reply: \"" + r.reply + "\"");
      console.log("  would call HA: " + (logHA.calls.join(", ") || "(none)"));
    } else {
      console.log("ESCALATE to the LLM  (" + r.escalate + ")" + (r.candidates ? " -> " + r.candidates.join(" / ") : ""));
    }
  });
}
