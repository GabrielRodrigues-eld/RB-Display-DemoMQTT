"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createFakeFactory, createInitialStock } = require("../src/simulation/fake-factory");
const { silentLogger, testConfig, waitFor } = require("./helpers");

class SimulationTransport extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.publications = [];
  }

  subscribe(_topic, _options, callback) { callback(null); }

  publish(topic, payload, options, callback = () => {}) {
    this.publications.push({ topic, payload: JSON.parse(payload), options });
    callback(null);
  }

  end(_force, _options, callback) { callback(); }
}

test("estoque inicial simulado usa o formato físico para posições vazias", () => {
  const stock = createInitialStock("normal");
  const empty = stock.filter((item) => item.workpiece.id === "0");
  assert.equal(empty.length, 3);
  for (const item of empty) assert.deepEqual(item.workpiece, { id: "0", state: "", type: "" });
});

for (const emitShipped of [false, true]) {
  test(`simulador conclui ciclo ${emitShipped ? "com" : "sem"} SHIPPED`, async (t) => {
    const transport = new SimulationTransport();
    const config = testConfig({
      MODE: "simulation",
      SIMULATION_EMIT_SHIPPED: String(emitShipped),
      SIMULATION_SPEED: "10",
      SIMULATION_SNAPSHOT_PERIOD_MS: "10000",
    });
    const factory = createFakeFactory({
      config,
      logger: silentLogger(),
      mqttConnect: () => transport,
    });
    factory.start();
    t.after(async () => factory.stop());
    transport.emit("connect");
    transport.emit("message", config.mqtt.orderTopic, Buffer.from(JSON.stringify({ type: "WHITE", ts: new Date().toISOString() })));

    await waitFor(() => transport.publications
      .filter((entry) => entry.topic === config.mqtt.orderStateTopic)
      .map((entry) => entry.payload.state)
      .filter((state) => state === "WAITING_FOR_ORDER").length >= 2, 2000);

    const states = transport.publications
      .filter((entry) => entry.topic === config.mqtt.orderStateTopic)
      .map((entry) => entry.payload.state);
    const cycle = states.slice(states.indexOf("ORDERED"));
    assert.equal(cycle[0], "ORDERED");
    assert.ok(cycle.filter((state) => state === "IN_PROCESS").length >= 2);
    assert.equal(cycle.includes("SHIPPED"), emitShipped);
    assert.equal(cycle.at(-1), "WAITING_FOR_ORDER");
  });
}
