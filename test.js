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
 * test.js - the dependency-free test suite (`npm test`).
 *
 * Drives home-core.js with a FAKE Home Assistant client, so the exact code the MCP
 * server runs is exercised with no HA, no network, no deps - same rule as
 * resonance-memory's suite. The fake records every service call so we can assert the
 * substrate translated a friendly intent into the right HA service, and that the
 * safety gates held.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { createCore, resolveService } = require("./home-core.js");
const { createRouter } = require("./router.js");

// ------------------------------------------------------------- tiny test runner
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); passed++; }
  catch (e) { console.log("  FAIL " + name + "\n         " + e.message); failed++; }
}
async function atest(name, fn) {
  try { await fn(); console.log("  ok   " + name); passed++; }
  catch (e) { console.log("  FAIL " + name + "\n         " + e.message); failed++; }
}

// ---------------------------------------------------------------- the fake HA
function fakeHA(states) {
  const calls = [];
  return {
    calls,
    async getStates() { return states; },
    async callService(domain, service, data) { calls.push({ domain, service, data }); return null; },
  };
}
// RH-14 fixtures: a totally-unreachable HA, and a flaky one that fails specific entities.
function downHA() {
  const err = () => { throw new Error("Home Assistant unreachable at http://localhost:8123 (connection failed)"); };
  return { async getStates() { err(); }, async callService() { err(); } };
}
function flakyHA(states, failIds) {
  const calls = [], fail = new Set(failIds);
  return {
    calls,
    async getStates() { return states; },
    async callService(domain, service, data) {
      if (fail.has(data.entity_id)) throw new Error("Home Assistant returned HTTP 500 for POST /api/services/" + domain + "/" + service);
      calls.push({ domain, service, data }); return null;
    },
  };
}

const STATES = [
  { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen Light" } },
  { entity_id: "light.hall", state: "off", attributes: {} },
  { entity_id: "climate.hall", state: "heat", attributes: { current_temperature: 20, temperature: 21 } },
  { entity_id: "lock.front_door", state: "unlocked", attributes: {} },
  { entity_id: "binary_sensor.living_window", state: "on", attributes: { friendly_name: "Living room window", device_class: "window" } },
  { entity_id: "sun.sun", state: "above_horizon", attributes: {} }, // must be filtered OUT
];

const CONFIG = {
  aliases: {
    "kitchen light": "light.kitchen",
    "downstairs lights": ["light.kitchen", "light.hall"],
    "thermostat": "climate.hall",
    "front door": "lock.front_door",
  },
  gates: { "lock.front_door": "confirm" },
  routines: { "bedtime": [{ target: "downstairs lights", state: "off" }, { target: "thermostat", temperature: 17 }] },
};

(async () => {
  console.log("\nservice mapping (resolveService)");
  test("light off -> light.turn_off", () => {
    assert.deepStrictEqual(resolveService("light", { state: "off" }), { domain: "light", service: "turn_off", data: {} });
  });
  test("climate temperature -> climate.set_temperature", () => {
    const r = resolveService("climate", { temperature: 17 });
    assert.strictEqual(r.service, "set_temperature");
    assert.strictEqual(r.data.temperature, 17);
  });
  test("lock 'off' locks; 'on' unlocks", () => {
    assert.strictEqual(resolveService("lock", { state: "off" }).service, "lock");
    assert.strictEqual(resolveService("lock", { state: "on" }).service, "unlock");
  });
  test("nonsense change -> no mapping (never guesses)", () => {
    assert.strictEqual(resolveService("light", { temperature: 9 }), null);
  });

  console.log("\nget_home_state");
  await atest("renders friendly lines and drops non-home domains (sun)", async () => {
    const c = createCore({ ha: fakeHA(STATES), config: CONFIG });
    const out = await c.getHomeState();
    assert.ok(out.includes("kitchen light: on"), "uses the config alias name (the user's own naming) over HA's");
    assert.ok(out.includes("thermostat: 20°C (set 21°C)"), "climate rendered with setpoint");
    assert.ok(out.includes("front door: unlocked"));
    assert.ok(!out.includes("sun"), "non-home domain filtered out");
  });
  await atest("query narrows the snapshot", async () => {
    const c = createCore({ ha: fakeHA(STATES), config: CONFIG });
    const out = await c.getHomeState("window");
    assert.ok(out.includes("Living room window"));
    assert.ok(!out.includes("Kitchen light"), "unrelated devices excluded");
  });

  console.log("\nset_devices");
  await atest("alias group actuates every entity in the group", async () => {
    const ha = fakeHA(STATES);
    const c = createCore({ ha, config: CONFIG });
    await c.setDevices([{ target: "downstairs lights", state: "off" }]);
    assert.strictEqual(ha.calls.length, 2, "both lights called");
    assert.ok(ha.calls.every((k) => k.service === "turn_off"));
  });
  await atest("thermostat temperature routed to climate.set_temperature", async () => {
    const ha = fakeHA(STATES);
    const c = createCore({ ha, config: CONFIG });
    await c.setDevices([{ target: "thermostat", temperature: 17 }]);
    assert.deepStrictEqual(ha.calls[0], { domain: "climate", service: "set_temperature", data: { entity_id: "climate.hall", temperature: 17 } });
  });
  await atest("gated lock REFUSES without confirm (and does not call HA)", async () => {
    const ha = fakeHA(STATES);
    const c = createCore({ ha, config: CONFIG });
    const out = await c.setDevices([{ target: "front door", state: "off" }]);
    assert.ok(out.text.includes("needs confirmation"), "surfaces the gate");
    assert.strictEqual(ha.calls.length, 0, "nothing actuated");
  });
  await atest("gated lock actuates WITH confirm:true", async () => {
    const ha = fakeHA(STATES);
    const c = createCore({ ha, config: CONFIG });
    await c.setDevices([{ target: "front door", state: "off", confirm: true }]);
    assert.strictEqual(ha.calls.length, 1);
    assert.strictEqual(ha.calls[0].service, "lock");
  });
  await atest("blocked entity never actuates", async () => {
    const ha = fakeHA(STATES);
    const c = createCore({ ha, config: { ...CONFIG, gates: { "light.kitchen": "block" } } });
    const out = await c.setDevices([{ target: "kitchen light", state: "off" }]);
    assert.ok(out.text.includes("blocked"));
    assert.strictEqual(ha.calls.length, 0);
  });
  await atest("unknown target is reported, not guessed", async () => {
    const ha = fakeHA(STATES);
    const c = createCore({ ha, config: CONFIG });
    const out = await c.setDevices([{ target: "disco ball", state: "on" }]);
    assert.ok(out.text.includes("unknown target"));
    assert.strictEqual(ha.calls.length, 0);
  });

  console.log("\nrun_routine");
  await atest("bedtime routine runs all its steps", async () => {
    const ha = fakeHA(STATES);
    const c = createCore({ ha, config: CONFIG });
    const out = await c.runRoutine("bedtime");
    // 2 lights off + 1 thermostat set = 3 HA calls
    assert.strictEqual(ha.calls.length, 3);
    assert.ok(out.startsWith("Ran routine \"bedtime\""));
  });
  await atest("unknown routine lists the known ones", async () => {
    const c = createCore({ ha: fakeHA(STATES), config: CONFIG });
    const out = await c.runRoutine("party");
    assert.ok(out.includes("bedtime"), "names an available routine");
  });

  // ------------------------------------------------------------ the reflex router
  // The fast-path layer: it must EXECUTE the unambiguous/safe commands via home-core
  // and FAIL OPEN (escalate to the model) on everything else - especially anything
  // gated. A router that ever actuates a lock, or guesses at "the lights", is a bug.
  console.log("\nrouter (reflex layer)");
  const RCONFIG = { ...CONFIG, aliases: { ...CONFIG.aliases, "blinds": "cover.blinds" } };
  const mkRouter = (ha) => { const core = createCore({ ha, config: RCONFIG }); return createRouter({ core, config: RCONFIG }); };

  await atest("simple on/off is handled with no ambiguity", async () => {
    const ha = fakeHA(STATES);
    const r = await mkRouter(ha).handle("turn on the kitchen lights");
    assert.strictEqual(r.handled, true);
    assert.strictEqual(ha.calls[0].service, "turn_on");
    assert.strictEqual(ha.calls[0].data.entity_id, "light.kitchen");
  });
  await atest("politeness/filler is stripped before matching", async () => {
    const r = await mkRouter(fakeHA(STATES)).handle("hey, could you please turn on the kitchen light");
    assert.strictEqual(r.handled, true);
    assert.ok(r.reply.includes("kitchen light"));
  });
  await atest("group alias actuates the whole group in one command", async () => {
    const ha = fakeHA(STATES);
    const r = await mkRouter(ha).handle("turn the downstairs lights off");
    assert.strictEqual(r.handled, true);
    assert.strictEqual(ha.calls.length, 2); // kitchen + hall (STATES has no living_room)
  });
  await atest("'set X to N' routes to the thermostat", async () => {
    const ha = fakeHA(STATES);
    const r = await mkRouter(ha).handle("set the thermostat to 19 degrees");
    assert.strictEqual(r.handled, true);
    assert.strictEqual(ha.calls[0].service, "set_temperature");
    assert.strictEqual(ha.calls[0].data.temperature, 19);
  });
  await atest("'set X to N percent' becomes brightness, not temperature", async () => {
    const ha = fakeHA(STATES);
    const r = await mkRouter(ha).handle("set the kitchen light to 50 percent");
    assert.strictEqual(r.handled, true);
    assert.strictEqual(ha.calls[0].service, "turn_on");
    assert.ok(ha.calls[0].data.brightness > 120 && ha.calls[0].data.brightness < 135);
  });
  await atest("open/close drives a cover", async () => {
    const ha = fakeHA(STATES);
    const r = await mkRouter(ha).handle("open the blinds");
    assert.strictEqual(r.handled, true);
    assert.strictEqual(ha.calls[0].service, "open_cover");
  });

  await atest("AMBIGUOUS target escalates and actuates nothing", async () => {
    const ha = fakeHA(STATES);
    const r = await mkRouter(ha).handle("turn on the lights");
    assert.strictEqual(r.handled, false);
    assert.strictEqual(r.escalate, "ambiguous");
    assert.strictEqual(ha.calls.length, 0);
  });
  await atest("GATED device (lock/garage) never reflex-actuates - escalates", async () => {
    const ha = fakeHA(STATES);
    const r = await mkRouter(ha).handle("open the front door"); // front door is a gated lock
    assert.strictEqual(r.handled, false);
    assert.strictEqual(r.escalate, "gated");
    assert.strictEqual(ha.calls.length, 0);
  });
  await atest("unknown target escalates (never guesses)", async () => {
    const ha = fakeHA(STATES);
    const r = await mkRouter(ha).handle("turn off everything");
    assert.strictEqual(r.handled, false);
    assert.strictEqual(r.escalate, "unknown-target");
    assert.strictEqual(ha.calls.length, 0);
  });
  await atest("verb the device can't take escalates (temperature on a light)", async () => {
    const ha = fakeHA(STATES);
    const r = await mkRouter(ha).handle("set the kitchen light to 20");
    assert.strictEqual(r.handled, false);
    assert.strictEqual(r.escalate, "unsupported");
    assert.strictEqual(ha.calls.length, 0);
  });
  await atest("a non-command (no grammar) escalates", async () => {
    const ha = fakeHA(STATES);
    const r = await mkRouter(ha).handle("what's the weather like tomorrow");
    assert.strictEqual(r.handled, false);
    assert.strictEqual(r.escalate, "no-match");
    assert.strictEqual(ha.calls.length, 0);
  });

  // ------------------------------------------------------------ RH-14 resilience
  // HA down or flaking must degrade HONESTLY: a clear error on reads, no false success
  // on writes, and a partial group failure that names exactly what did and didn't land.
  console.log("\nresilience (RH-14)");

  await atest("get_home_state returns a clear error (not a crash) when HA is unreachable", async () => {
    const c = createCore({ ha: downHA(), config: CONFIG });
    const out = await c.getHomeState();
    assert.ok(/couldn'?t read the home/i.test(out), "clear, human error");
    assert.ok(/unreachable/i.test(out), "names the cause");
  });
  await atest("set_devices reports failure, not false success, when HA is unreachable", async () => {
    const c = createCore({ ha: downHA(), config: CONFIG });
    const r = await c.setDevices([{ target: "kitchen light", state: "on" }]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.actuationFailed, true);
    assert.ok(r.text.includes("failed") && /unreachable/i.test(r.text));
  });
  await atest("set_devices on a group names exactly which succeeded and which failed", async () => {
    const ha = flakyHA(STATES, ["light.hall"]);              // hall fails, kitchen succeeds
    const c = createCore({ ha, config: CONFIG });            // downstairs lights = [kitchen, hall]
    const r = await c.setDevices([{ target: "downstairs lights", state: "off" }]);
    assert.strictEqual(r.actuationFailed, true);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.results.filter((x) => x.status === "ok").map((x) => x.id), ["light.kitchen"]);
    assert.deepStrictEqual(r.results.filter((x) => x.status === "failed").map((x) => x.id), ["light.hall"]);
    assert.strictEqual(ha.calls.length, 1, "only the successful actuation was recorded");
  });
  await atest("reflex router does NOT claim success when the actuation failed", async () => {
    const r = await mkRouter(downHA()).handle("turn on the kitchen light");
    assert.strictEqual(r.handled, true);
    assert.strictEqual(r.ok, false);
    assert.ok(!/kitchen light on\b/i.test(r.reply), "reply must not fake success");
    assert.ok(/down|unreach|couldn/i.test(r.reply), "reply is honest about the failure");
  });

  // ------------------------------------------------------- server + shipped config
  // Exercise the REAL server.js JSON-RPC stdio loop (not just the core), and prove the
  // example config a user copies actually loads and is internally consistent.
  console.log("\nserver + config (congruence)");

  test("MCP stdio: initialize + tools/list over the real server.js", () => {
    const input =
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n";
    const res = spawnSync(process.execPath, [path.join(__dirname, "server.js")], { input, encoding: "utf8", timeout: 8000 });
    const lines = (res.stdout || "").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const init = lines.find((l) => l.id === 1), list = lines.find((l) => l.id === 2);
    assert.strictEqual(init.result.serverInfo.name, "resonance-home");
    assert.ok(init.result.serverInfo.version, "serverInfo carries a version");
    assert.deepStrictEqual(list.result.tools.map((t) => t.name).sort(), ["get_home_state", "run_routine", "set_devices"]);
  });
  test("home-config.example.json is valid, loads, and its gates reference real aliases", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "home-config.example.json"), "utf8"));
    const c = createCore({ ha: fakeHA([]), config: cfg });
    assert.ok(c.getHomeState && c.setDevices && c.runRoutine, "core builds from the example");
    const targets = new Set(Object.values(cfg.aliases).flat());
    for (const id of Object.keys(cfg.gates || {})) assert.ok(targets.has(id), "gate references a known entity: " + id);
    for (const steps of Object.values(cfg.routines || {}))
      for (const s of steps) assert.ok(cfg.aliases[s.target], "routine step targets a known alias: " + s.target);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
