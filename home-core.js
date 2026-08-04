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

  // Resolve a friendly target to concrete entity_ids. An unknown target resolves to
  // [] so the caller can say "I don't know a 'X'" rather than actuate the wrong thing.
  function resolve(target) {
    if (!target) return [];
    if (aliases[target]) return [].concat(aliases[target]);
    // Case-insensitive fallback so "Downstairs Lights" still finds "downstairs lights".
    const key = Object.keys(aliases).find((k) => k.toLowerCase() === String(target).toLowerCase());
    return key ? [].concat(aliases[key]) : [];
  }

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
    const states = (await ha.getStates()) || [];
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
   * confirm? }. Returns a per-item report so the model can tell the user exactly what
   * happened - including what it was NOT allowed to do (a gated lock without confirm).
   */
  async function setDevices(changes) {
    changes = Array.isArray(changes) ? changes : (changes ? [changes] : []);
    if (!changes.length) return "No changes given.";
    const out = [];
    for (const change of changes) {
      const ids = resolve(change.target);
      if (!ids.length) { out.push("? unknown target: \"" + change.target + "\""); continue; }
      for (const id of ids) {
        const gate = gates[id];
        if (gate === "block") { out.push("x " + (friendlyOf[id] || id) + ": blocked (not remotely controllable)"); continue; }
        if (gate === "confirm" && !change.confirm) {
          out.push("! " + (friendlyOf[id] || id) + ": needs confirmation - re-send this change with confirm:true");
          continue;
        }
        const svc = resolveService(domainOf(id), change);
        if (!svc) { out.push("? " + (friendlyOf[id] || id) + ": don't know how to apply that"); continue; }
        try {
          await ha.callService(svc.domain, svc.service, { entity_id: id, ...svc.data });
          out.push("- " + (friendlyOf[id] || id) + ": " + svc.service.replace(/_/g, " "));
        } catch (e) {
          out.push("x " + (friendlyOf[id] || id) + ": failed (" + e.message + ")");
        }
      }
    }
    return out.join("\n");
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
    const report = await setDevices(routines[key]);
    return "Ran routine \"" + key + "\":\n" + report;
  }

  return { getHomeState, setDevices, runRoutine };
}

module.exports = { createCore, resolveService, REPORT_DOMAINS };
