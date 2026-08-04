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
 * server.js - the MCP server: a safe pair of hands for a local LLM's smart home.
 *
 * Three verbs, each dead simple, mirroring resonance-memory's philosophy:
 *   get_home_state({ query? })   -> a plain-language snapshot of the house (read-only)
 *   set_devices({ changes })     -> apply one or more device changes (gated)
 *   run_routine({ name })        -> execute a named routine ("bedtime", "leaving")
 *
 * The model reasons; the server acts safely. All the house-specific knowledge - which
 * friendly name maps to which entity, what's gated, what a routine does - lives in a
 * config file the SERVER owns, never in the model's head.
 *
 * Pure Node stdlib + built-in fetch (Node 18+). Speaks MCP over stdio as
 * line-delimited JSON-RPC 2.0. Wire it into any MCP client alongside resonance-memory
 * and the model gains both a memory and a house.
 */

const fs = require("fs");
const path = require("path");
const { HAClient } = require("./ha-client.js");
const { createCore } = require("./home-core.js");
const VERSION = require("./package.json").version;

// The house config: aliases + gates + routines. Kept beside the exe/data by default,
// overridable so the panel (later) and the server read the same file.
const CONFIG_PATH = process.env.HOME_CONFIG_PATH ||
  path.join(process.env.USERPROFILE || process.env.HOME || ".", ".resonance-home", "home-config.json");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return { aliases: {}, gates: {}, routines: {} }; }
}

const ha = new HAClient({
  baseUrl: process.env.HA_URL || "http://localhost:8123",
  token: process.env.HA_TOKEN || "",
});

// Config is read per-call so editing the house config (a new alias, a new routine)
// takes effect without restarting the client - same live-config idea as the memory
// server's field toggle.
function core() { return createCore({ ha, config: loadConfig() }); }

const TOOLS = [
  {
    name: "get_home_state",
    description: "Check the current state of the home before you act or answer. Returns a plain-language snapshot of lights, switches, the thermostat, locks, doors/windows, and covers. Call this whenever the user refers to the house ('is anything on?', 'are the windows shut?', 'I'm going to bed') so you reason over the REAL state, not an assumption. Read-only and cheap. Pass an optional `query` to narrow it (e.g. 'windows', 'downstairs'). Example: get_home_state({\"query\":\"windows\"})",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Optional keyword to narrow the snapshot (a room, a device type). Omit for the whole house." } },
    },
  },
  {
    name: "set_devices",
    description: "Change one or more devices. Pass `changes`: an array of { target, ... } where `target` is a friendly name from get_home_state. Set `state` to \"on\"/\"off\" (lights, switches, covers, locks), or `temperature` (thermostat), or `brightness` (lights). Compose the user's intent yourself: for 'I'm going to bed' you might turn off the downstairs lights and lower the thermostat in one call. Some devices (locks, garage doors) are GATED: they return 'needs confirmation' unless you include confirm:true on that change — do that only when the user clearly wants it. Example: set_devices({\"changes\":[{\"target\":\"downstairs lights\",\"state\":\"off\"},{\"target\":\"thermostat\",\"temperature\":17}]})",
    inputSchema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          description: "The device changes to apply.",
          items: {
            type: "object",
            properties: {
              target: { type: "string", description: "Friendly device/group name from get_home_state." },
              state: { type: "string", description: "\"on\" or \"off\" (also open/closed, lock/unlock)." },
              temperature: { type: "number", description: "Target temperature in °C, for a thermostat." },
              brightness: { type: "number", description: "0-255 brightness, for a light." },
              confirm: { type: "boolean", description: "Set true to actuate a gated device (a lock, a garage door)." },
            },
            required: ["target"],
          },
        },
      },
      required: ["changes"],
    },
  },
  {
    name: "run_routine",
    description: "Run a named routine the household has pre-defined (e.g. 'bedtime', 'leaving', 'movie'). Use this when the user names or clearly invokes a known routine and you'd rather run the household's canonical version than compose the steps yourself. Recall the routine names from get_home_state's house or just try the obvious one; an unknown name lists what's available. Example: run_routine({\"name\":\"bedtime\"})",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The routine to run." } },
      required: ["name"],
    },
  },
];

async function callTool(name, args) {
  args = args || {};
  const c = core();
  if (name === "get_home_state") return await c.getHomeState(args.query);
  if (name === "set_devices") return await c.setDevices(args.changes);
  if (name === "run_routine") return await c.runRoutine(args.name);
  throw new Error("unknown tool: " + name);
}

// --------------------------------------------------------- MCP stdio plumbing
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "resonance-home", version: VERSION },
    } };
  }
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    try {
      const text = await callTool(params.name, params.arguments || {});
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
    } catch (e) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } };
    }
  }
  if (method && method.startsWith("notifications/")) return null;
  if (id !== undefined) return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } };
  return null;
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    const res = await handle(req);
    if (res) send(res);
  }
});

process.stderr.write("resonance-home MCP server running on stdio (config: " + CONFIG_PATH + ")\n");
