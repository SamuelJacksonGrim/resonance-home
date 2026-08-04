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
const { createCore, resolveService } = require("./home-core.js");

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
    assert.ok(out.includes("needs confirmation"), "surfaces the gate");
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
    assert.ok(out.includes("blocked"));
    assert.strictEqual(ha.calls.length, 0);
  });
  await atest("unknown target is reported, not guessed", async () => {
    const ha = fakeHA(STATES);
    const c = createCore({ ha, config: CONFIG });
    const out = await c.setDevices([{ target: "disco ball", state: "on" }]);
    assert.ok(out.includes("unknown target"));
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

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
