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
 * ha-client.js - the thinnest possible Home Assistant REST wrapper.
 *
 * HA exposes exactly what we need over plain HTTP + a long-lived access token:
 *   GET  /api/states                          -> every entity's current state
 *   POST /api/services/<domain>/<service>      -> call a service (turn on, set temp...)
 *
 * That is the WHOLE integration surface. No websockets, no HA Python, no deps -
 * just built-in fetch (Node 18+), same zero-dependency rule as resonance-memory.
 * This client knows nothing about aliases, gates, or routines; it only speaks raw
 * HA. All the safety and friendliness lives one layer up in home-core.js, so this
 * stays trivially testable and swappable (a fake client drives the test suite).
 */

class HAClient {
  constructor({ baseUrl, token, timeoutMs = 10000 } = {}) {
    // Trim a trailing slash so `${baseUrl}/api/...` never doubles up.
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token || "";
    this.timeoutMs = timeoutMs;
  }

  async _req(path, init = {}) {
    if (!this.baseUrl) throw new Error("HA_URL is not set");
    if (!this.token) throw new Error("HA_TOKEN is not set");
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: {
        Authorization: "Bearer " + this.token,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error("HA " + init.method + " " + path + " -> HTTP " + res.status);
    // Some service calls return an empty body; guard the JSON parse.
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /* Every entity and its current state: [{ entity_id, state, attributes }, ...]. */
  getStates() { return this._req("/api/states", { method: "GET" }); }

  /*
   * Call an HA service. `data` targets entities and carries params, e.g.
   *   callService("light", "turn_off", { entity_id: "light.kitchen" })
   *   callService("climate", "set_temperature", { entity_id: "climate.hall", temperature: 17 })
   */
  callService(domain, service, data = {}) {
    return this._req("/api/services/" + domain + "/" + service, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
}

module.exports = { HAClient };
