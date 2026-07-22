"use strict";

const { EventEmitter } = require("node:events");
const { createConfig } = require("../src/config");

function testConfig(overrides = {}) {
  const base = createConfig({
    MODE: "test",
    APP_PORT: "8080",
    MQTT_ENABLE_ENVIRONMENT_TOPICS: "false",
    MQTT_ENABLE_RAW_DIAGNOSTICS: "true",
    FACTORY_COMMANDS_ENABLED: "true",
    ORDER_ACCEPTANCE_TIMEOUT_MS: "200",
    STOCK_STALE_AFTER_MS: "1000",
    TOPIC_STALE_AFTER_MS: "1000",
    ...overrides,
  });
  return { ...base, app: { ...base.app, port: 0 } };
}

function physicalStockPayload(timestamp = "2026-07-22T12:00:00.000Z") {
  const workpieces = {
    A1: { id: "0", state: "", type: "" },
    A2: { id: "W-001", state: "RAW", type: "WHITE" },
    A3: { id: "W-002", state: "RAW", type: "WHITE" },
    B1: { id: "R-001", state: "RAW", type: "RED" },
    B2: { id: "R-002", state: "RAW", type: "RED" },
    B3: { id: "R-003", state: "RAW", type: "RED" },
    C1: { id: "0", state: "", type: "" },
    C2: { id: "0", state: "", type: "" },
    C3: { id: "B-001", state: "RAW", type: "BLUE" },
  };
  return {
    ts: timestamp,
    stockItems: Object.entries(workpieces).map(([location, workpiece]) => ({ location, workpiece })),
  };
}

function stockPayload(counts = { WHITE: 1, RED: 1, BLUE: 1 }, timestamp = "2026-07-21T12:00:00.000Z") {
  const available = [];
  for (const type of ["WHITE", "RED", "BLUE"]) {
    for (let index = 0; index < (counts[type] || 0); index += 1) available.push({ id: `${type}-${index + 1}`, type, state: "RAW" });
  }
  const locations = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"];
  return {
    ts: timestamp,
    stockItems: locations.map((location, index) => ({ location, workpiece: available[index] || null })),
  };
}

function orderState(state = "WAITING_FOR_ORDER", type = "", timestamp = "2026-07-21T12:00:00.000Z") {
  return { ts: timestamp, state, type };
}

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.published = [];
  }

  connect() {
    queueMicrotask(() => this.emit("state", {
      connected: this.connected,
      connecting: false,
      reconnectCount: 0,
      clientId: "fake-gateway-client",
      brokerUrl: "mqtt://test-broker:1883",
      lastError: null,
      connectedAt: new Date().toISOString(),
    }));
    return this;
  }

  async publishOrder(payload) {
    this.published.push({ payload, qos: 0, retain: false, topic: "f/o/order" });
    this.emit("order-published", { payload, qos: 0, retain: false, topic: "f/o/order" });
    return { topic: "f/o/order", qos: 0, retain: false };
  }

  async end() {}
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

function waitFor(predicate, timeoutMs = 2000, intervalMs = 10) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const value = await predicate();
        if (value) {
          resolve(value);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`Condição não atendida em ${timeoutMs} ms.`));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

module.exports = { FakeMqttClient, orderState, physicalStockPayload, silentLogger, stockPayload, testConfig, waitFor };
