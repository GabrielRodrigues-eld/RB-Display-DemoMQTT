"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { OrderService, OrderError } = require("../src/order-service");
const { StateStore } = require("../src/state-store");
const { FakeMqttClient, orderState, silentLogger, stockPayload, testConfig } = require("./helpers");

const READY_STATIONS = ["dsi", "dso", "hbw", "mpo", "vgr", "sld"];

function readyContext(options = {}) {
  const config = testConfig(options.config);
  const store = new StateStore(config);
  store.setMqttState({ connected: true, connecting: false });
  store.observe("f/i/order", JSON.stringify(orderState()), { qos: 0, retain: false });
  store.observe("f/i/stock", JSON.stringify(stockPayload(options.counts)), { qos: 0, retain: false });
  const mqttClient = new FakeMqttClient();
  const service = new OrderService(config, store, mqttClient, silentLogger(), options.serviceOptions);
  store.on("factory-order-state", (factory) => service.handleFactoryState(factory));
  return { config, mqttClient, service, store };
}

test("bloqueia pedido sem WAITING_FOR_ORDER", async () => {
  const context = readyContext();
  context.store.observe("f/i/order", JSON.stringify(orderState("IN_PROCESS", "WHITE")), { qos: 0, retain: false });
  await assert.rejects(context.service.requestOrder({ type: "WHITE" }), (error) => error instanceof OrderError && error.code === "FACTORY_NOT_READY");
});

test("bloqueia falta de estoque e pedido já pendente", async () => {
  const empty = readyContext({ counts: { WHITE: 0, RED: 1, BLUE: 1 } });
  await assert.rejects(empty.service.requestOrder({ type: "WHITE" }), (error) => error.code === "OUT_OF_STOCK");

  const context = readyContext();
  await context.service.requestOrder({ type: "RED" });
  await assert.rejects(context.service.requestOrder({ type: "BLUE" }), (error) => error.code === "ORDER_ALREADY_PENDING");
  context.service.close();
});

test("gera timestamp UTC sem offset, publica uma vez em QoS 0 e retain false", async () => {
  const fixed = new Date("2026-07-21T10:00:00.123Z");
  const context = readyContext({ serviceOptions: { clock: () => fixed } });
  const result = await context.service.requestOrder({ type: "BLUE" });
  assert.equal(context.mqttClient.published.length, 1);
  assert.deepEqual(context.mqttClient.published[0], {
    topic: "f/o/order",
    qos: 0,
    retain: false,
    payload: '{"type":"BLUE","ts":"2026-07-21T10:00:00.123Z"}',
  });
  assert.equal(result.order.payload.ts, "2026-07-21T10:00:00.123Z");
  context.service.close();
});

test("permite reativar explicitamente o offset legado de mais 725 minutos", async () => {
  const fixed = new Date("2026-07-21T10:00:00.123Z");
  const context = readyContext({
    config: { ORDER_TIMESTAMP_OFFSET_MINUTES: "725" },
    serviceOptions: { clock: () => fixed },
  });
  const result = await context.service.requestOrder({ type: "BLUE" });
  assert.deepEqual(context.mqttClient.published[0], {
    topic: "f/o/order",
    qos: 0,
    retain: false,
    payload: '{"type":"BLUE","ts":"2026-07-21T22:05:00.123Z"}',
  });
  assert.deepEqual(Object.keys(JSON.parse(context.mqttClient.published[0].payload)), ["type", "ts"]);
  assert.equal(result.order.createdAt, "2026-07-21T10:00:00.123Z");
  assert.deepEqual(result.order.timestampPolicy, {
    generatedAtUtc: "2026-07-21T10:00:00.123Z",
    offsetMinutes: 725,
  });
  context.service.close();
});

test("timeout marca uncertain sem publicar novamente", async () => {
  const context = readyContext({ config: { ORDER_ACCEPTANCE_TIMEOUT_MS: "100" } });
  await context.service.requestOrder({ type: "WHITE" });
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(context.store.pendingOrder.status, "uncertain");
  assert.equal(context.mqttClient.published.length, 1);
  context.service.close();
});

test("libera pedido em IN_PROCESS -> WAITING sem exigir SHIPPED", async () => {
  const context = readyContext();
  await context.service.requestOrder({ type: "WHITE" });
  for (const state of ["ORDERED", "IN_PROCESS"]) {
    context.store.observe("f/i/order", JSON.stringify(orderState(state, "WHITE")), { qos: 0, retain: false });
  }
  context.store.observe("f/i/order", JSON.stringify(orderState("WAITING_FOR_ORDER", "")), { qos: 0, retain: false });
  assert.equal(context.store.pendingOrder, null);
  assert.equal(context.store.lastOrder.completedWithoutShipped, true);
  assert.equal(context.store.lastOrder.completionReason, "returned-to-waiting");
  context.service.close();
});

test("continua reconhecendo ciclo com SHIPPED", async () => {
  const context = readyContext();
  await context.service.requestOrder({ type: "WHITE" });
  for (const state of ["ORDERED", "IN_PROCESS", "SHIPPED"]) {
    context.store.observe("f/i/order", JSON.stringify(orderState(state, "WHITE")), { qos: 0, retain: false });
  }
  assert.equal(context.store.pendingOrder.status, "awaiting_ready");
  context.store.observe("f/i/order", JSON.stringify(orderState("WAITING_FOR_ORDER", "")), { qos: 0, retain: false });
  assert.equal(context.store.pendingOrder, null);
  assert.equal(context.store.lastOrder.completedWithoutShipped, false);
  context.service.close();
});

test("IN_PROCESS repetido não duplica transição e WAITING duplicado é idempotente", async () => {
  const context = readyContext();
  await context.service.requestOrder({ type: "RED" });
  context.store.observe("f/i/order", JSON.stringify(orderState("ORDERED", "RED")), { qos: 0, retain: false });
  for (let index = 0; index < 4; index += 1) {
    context.store.observe("f/i/order", JSON.stringify(orderState("IN_PROCESS", "RED")), { qos: 0, retain: false });
  }
  assert.equal(context.store.pendingOrder.transitions.filter((item) => item.status === "in_process").length, 1);
  context.store.observe("f/i/order", JSON.stringify(orderState("WAITING_FOR_ORDER", "")), { qos: 0, retain: false });
  const completedAt = context.store.lastOrder.completedAt;
  context.store.observe("f/i/order", JSON.stringify(orderState("WAITING_FOR_ORDER", "")), { qos: 0, retain: false });
  assert.equal(context.store.pendingOrder, null);
  assert.equal(context.store.lastOrder.completedAt, completedAt);
  context.service.close();
});

test("factory read-only rejeita POST antes de qualquer publicação MQTT", async () => {
  const context = readyContext({ config: { MODE: "factory", MQTT_URL: "mqtt://192.168.0.10:1883", FACTORY_COMMANDS_ENABLED: "false" } });
  await assert.rejects(
    context.service.requestOrder({ type: "WHITE" }),
    (error) => error instanceof OrderError && error.code === "FACTORY_COMMANDS_DISABLED" && error.statusCode === 403,
  );
  assert.equal(context.mqttClient.published.length, 0);
  context.service.close();
});

test("bootstrap inferido permite pedido quando a trava de comandos foi habilitada explicitamente", async () => {
  let now = 1000;
  const config = testConfig({
    MODE: "factory",
    MQTT_URL: "mqtt://192.168.0.10:1883",
    FACTORY_COMMANDS_ENABLED: "true",
    FACTORY_INFER_WAITING_ON_BOOT: "true",
    FACTORY_BOOTSTRAP_GRACE_MS: "1000",
  });
  const store = new StateStore(config, { clock: () => now });
  store.setMqttState({ connected: true, connecting: false });
  store.observe("f/i/stock", JSON.stringify(stockPayload()), { qos: 0, retain: false });
  for (const station of READY_STATIONS) {
    store.observe(`f/i/state/${station}`, JSON.stringify({
      ts: "2026-07-22T12:00:00.000Z",
      station,
      code: 1,
      description: "",
      active: false,
      target: "",
    }), { qos: 0, retain: false });
  }
  now = 2000;
  assert.equal(store.getFactoryOrder().inferred, true);

  const mqttClient = new FakeMqttClient();
  const service = new OrderService(config, store, mqttClient, silentLogger(), {
    clock: () => new Date("2026-07-22T12:00:01.000Z"),
  });
  await service.requestOrder({ type: "WHITE" });
  assert.equal(mqttClient.published.length, 1);
  service.close();
});
