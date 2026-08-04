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
 * home-core.js - the smart-home verbs, as ONE implementation.
 *
 * Same shape as resonance-memory's memory-core: everything environment-specific is
 * INJECTED (the HA client, the config), nothing reached for - so the MCP server and
 * the test suite drive the EXACT same code, one with a real Home Assistant behind it
 * and one with a fake.
 *
 * Design invariant, inherited from resonance-memory: A SMALL MODEL CANNOT MISUSE IT.
 *   - The model only ever sees FRIENDLY NAMES ("front door", "downstairs lights"),
 *     never raw entity_ids. The registry owns that mapping; the model assigns none of it.
 *   - Safety GATES live in the substrate, not the prompt. A gated entity (a lock, a
 *     garage door) refuses to actuate unless the call explicitly carries confirm:true.
 *     The model cannot argue its way past a gate; the gate is code, not a description.
 *   - Reads are free and safe; writes are the only thing that can gate. A read never
 *     actuates anything.
 *
 * The MODEL does the reasoning ("I'm going to bed" -> which of these primitives to
 * call, in what order, and what to report). The SERVER provides safe primitives and
 * honest state. That division is the whole point: no 500-line IF-THEN rule tree, and
 * no way for a confused 3B model to unlock your house.
 */

// Which HA domains we report in get_home_state. Deliberately bounded: these are the
// things a person reasons about at home. Everything else (update entities, sun, etc.)
// is noise to a bedtime/leaving decision and is left out to keep the snapshot legible.
const REPORT_DOMAINS = new Set(["light", "switch", "climate", "lock", "cover", "binary_sensor"]);

// Map a (domain, requested change) onto the concrete HA service to call. Keeping this
// table in the substrate is what lets the model say {target, state:"off"} without
// knowing that a light uses light.turn_off while a lock uses lock.lock.
function resolveService(domain, change) {
  const on = ["on", "open", "unlock", "unlocked"].includes(String(change.state || "").toLowerCase());
  const off = ["off", "closed", "close", "lock", "locked"].includes(String(change.state || "").toLowerCase());
  if (domain === "light" || domain === "switch") {
    if (change.brightness != null) return { domain, service: "turn_on", data: { brightness: change.brightness } };
    if (on) return { domain, service: "turn_on", data: {} };
    if (off) return { domain, service: "turn_off", data: {} };
  }
  if (domain === "climate" && change.temperature != null) {
    return { domain: "climate", service: "set_temperature", data: { temperature: change.temperature } };
  }
  if (domain === "lock") {
    if (on) return { domain: "lock", service: "unlock", data: {} };   // "on"/"unlock" = open the lock
    if (off) return { domain: "lock", service: "lock", data: {} };
  }
  if (domain === "cover") {
    if (on) return { domain: "cover", service: "open_cover", data: {} };
    if (off) return { domain: "cover", service: "close_cover", data: {} };
  }
  return null; // no safe mapping -> caller reports it, never guesses
}

function domainOf(entityId) { return String(entityId).split(".")[0]; }

/*
 * Resolve a friendly target to concrete entity_ids (exact, case-insensitive). Pulled to
 * module scope so the MCP verbs (createCore, below) and the reflex router (router.js)
 * expand a name to entities through the EXACT same code - one alias map, one resolver,
 * two callers. An unknown target resolves to [] so a caller can say "I don't know a 'X'"
 * rather than actuate the wrong thing.
 */
function resolveAlias(aliases, target) {
  if (!aliases || !target) return [];
  if (aliases[target]) return [].concat(aliases[target]);
  const key = Object.keys(aliases).find((k) => k.toLowerCase() === String(target).toLowerCase());
  return key ? [].concat(aliases[key]) : [];
}

/*
 * Build the four... no - the THREE verbs over an injected environment.
 *   ha        an HAClient (or any object with getStates()/callService())
 *   config    { aliases, gates, routines } - the substrate's knowledge of THIS house
 * Returns { getHomeState, setDevices, runRoutine }.
 */
function createCore({ ha, config = {} }) {
  const aliases = config.aliases || {};   // friendly name -> entity_id | [entity_id...]
  const gates = config.gates || {};       // entity_id -> "confirm" | "block"
  const routines = config.routines || {}; // name -> [ change, ... ]

  // Reverse map: entity_id -> the friendliest name we know for it, so state reads read
  // like a person talking, not like a config file.
  const friendlyOf = {};
  for (const [name, target] of Object.entries(aliases)) {
    for (const id of [].concat(target)) if (!friendlyOf[id]) friendlyOf[id] = name;
  }

  // Resolve a friendly target to concrete entity_ids (via the shared module-level
  // resolver, so the router and the MCP verbs never drift on how a name maps).
  function resolve(target) { return resolveAlias(aliases, target); }

  // Render one HA state row as a short human line: "Front door: unlocked".
  function line(s) {
    const id = s.entity_id;
    const name = friendlyOf[id] || (s.attributes && s.attributes.friendly_name) || id;
    let val = s.state;
    if (domainOf(id) === "climate") {
      const t = s.attributes && s.attributes.current_temperature;
      const sp = s.attributes && s.attributes.temperature;
      val = (t != null ? t + "°C" : s.state) + (sp != null ? " (set " + sp + "°C)" : "");
    }
    return name + ": " + val;
  }

  async function getHomeState(query) {
    // RH-14: a read must degrade to a clear message, never crash the server or - worse -
    // present a fabricated snapshot. If HA is unreachable, say so plainly.
    let states;
    try {
      states = (await ha.getStates()) || [];
    } catch (e) {
      return "Couldn't read the home: " + e.message + ". Check Home Assistant is running and HA_URL/HA_TOKEN are set.";
    }
    let rows = states.filter((s) => REPORT_DOMAINS.has(domainOf(s.entity_id)));
    // Optional keyword filter over the friendly name + area so "windows" or "downstairs"
    // narrows the snapshot. Empty query = the whole house.
    const q = String(query || "").trim().toLowerCase();
    if (q) {
      const terms = q.split(/\W+/).filter(Boolean);
      rows = rows.filter((s) => {
        const hay = (line(s) + " " + (s.attributes && s.attributes.area_id || "")).toLowerCase();
        return terms.some((t) => hay.includes(t));
      });
    }
    if (!rows.length) return q ? "Nothing at home matches \"" + query + "\"." : "No reportable devices found.";
    return rows.map(line).sort().join("\n");
  }

  /*
   * Apply a batch of changes. Each change: { target, state?, temperature?, brightness?,
   * confirm? }.
   *
   * Returns a STRUCTURED result { text, ok, actuationFailed, results } rather than a bare
   * string, so callers can tell success from failure without parsing prose (RH-14). The
   * MCP server hands `text` to the model; the reflex router checks `actuationFailed` so it
   * never reports a cheerful "done" for a change that didn't land. `results` carries a
   * per-item { id, name, status, line } - status is one of ok / failed / needs_confirm /
   * blocked / unsupported / unknown - so a partial group failure says exactly which entity
   * succeeded and which didn't.
   */
  async function setDevices(changes) {
    changes = Array.isArray(changes) ? changes : (changes ? [changes] : []);
    if (!changes.length) return { text: "No changes given.", ok: true, actuationFailed: false, results: [] };
    const results = [];
    for (const change of changes) {
      const ids = resolve(change.target);
      if (!ids.length) { results.push({ target: change.target, status: "unknown", line: "? unknown target: \"" + change.target + "\"" }); continue; }
      for (const id of ids) {
        const name = friendlyOf[id] || id;
        const gate = gates[id];
        if (gate === "block") { results.push({ id, name, status: "blocked", line: "x " + name + ": blocked (not remotely controllable)" }); continue; }
        if (gate === "confirm" && !change.confirm) {
          results.push({ id, name, status: "needs_confirm", line: "! " + name + ": needs confirmation - re-send this change with confirm:true" });
          continue;
        }
        const svc = resolveService(domainOf(id), change);
        if (!svc) { results.push({ id, name, status: "unsupported", line: "? " + name + ": don't know how to apply that" }); continue; }
        try {
          await ha.callService(svc.domain, svc.service, { entity_id: id, ...svc.data });
          results.push({ id, name, status: "ok", line: "- " + name + ": " + svc.service.replace(/_/g, " ") });
        } catch (e) {
          results.push({ id, name, status: "failed", line: "x " + name + ": failed (" + e.message + ")" });
        }
      }
    }
    const actuationFailed = results.some((r) => r.status === "failed");
    const ok = results.every((r) => r.status === "ok");
    let text = results.map((r) => r.line).join("\n");
    // When an actuation actually failed (not a gate/unknown, which are decisions), the batch
    // is suspect - HA may be unreachable - so say it once, plainly, so nothing reads as a
    // silent or false success.
    if (actuationFailed) text += "\n(Some changes did not apply — Home Assistant may be unreachable.)";
    return { text, ok, actuationFailed, results };
  }

  /*
   * Run a named routine defined in the house config (e.g. "bedtime"). This exists so a
   * model too weak to compose set_devices itself can still get orchestration - the
   * reasoning is baked into the config once, by a human. A capable model can ignore
   * routines and compose primitives directly; both paths hit the same setDevices.
   */
  async function runRoutine(name) {
    const key = Object.keys(routines).find((k) => k.toLowerCase() === String(name || "").toLowerCase());
    if (!key) {
      const known = Object.keys(routines);
      return known.length ? "No routine \"" + name + "\". Known routines: " + known.join(", ") + "."
                          : "No routines are configured for this house.";
    }
    const r = await setDevices(routines[key]);
    return "Ran routine \"" + key + "\":\n" + r.text;
  }

  return { getHomeState, setDevices, runRoutine };
}

module.exports = { createCore, resolveService, resolveAlias, domainOf, REPORT_DOMAINS };
