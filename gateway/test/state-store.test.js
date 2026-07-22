"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { StateStore } = require("../src/state-store");
const { orderState, stockPayload, testConfig } = require("./helpers");

const REQUIRED_STATIONS = ["dsi", "dso", "hbw", "mpo", "vgr", "sld"];

function observeStations(store, overrides = {}) {
  for (const station of REQUIRED_STATIONS) {
    const code = overrides[station] ?? 1;
    store.observe(`f/i/state/${station}`, JSON.stringify({
      ts: "2026-07-22T12:00:00.000Z",
      station,
      code,
      description: "",
      active: false,
      target: "",
    }), { qos: 0, retain: false });
  }
}

test("calcula stale de estoque pelo horário local de recebimento", () => {
  let now = 1000;
  const store = new StateStore(testConfig({ STOCK_STALE_AFTER_MS: "500" }), { clock: () => now });
  store.observe("f/i/stock", JSON.stringify(stockPayload()), { qos: 0, retain: false });
  assert.equal(store.getStock().stale, false);
  now = 1501;
  assert.equal(store.getStock().stale, true);
});

test("payload inválido incrementa diagnóstico e não derruba o store", () => {
  const store = new StateStore(testConfig());
  assert.doesNotThrow(() => store.observe("f/i/order", "{json-inválido", { qos: 0, retain: false }));
  const topic = store.getTopics().find((item) => item.topic === "f/i/order");
  assert.equal(topic.messageCount, 1);
  assert.equal(topic.parseErrorCount, 1);
  assert.equal(store.getFactoryOrder().valid, false);
});

test("mensagem válida de pedido é normalizada e preserva QoS/retain", () => {
  const store = new StateStore(testConfig());
  store.observe("f/i/order", JSON.stringify(orderState("ORDERED", "RED")), { qos: 0, retain: true });
  const factory = store.getFactoryOrder();
  assert.equal(factory.valid, false);
  assert.match(factory.errors.join(" "), /retained/);
  const topic = store.getTopics()[0];
  assert.equal(topic.qos, 0);
  assert.equal(topic.retain, true);
});

test("estado não retido é aceito para controle", () => {
  const store = new StateStore(testConfig());
  store.observe("f/i/order", JSON.stringify(orderState("ORDERED", "RED")), { qos: 0, retain: false });
  const factory = store.getFactoryOrder();
  assert.equal(factory.valid, true);
  assert.equal(factory.state, "ORDERED");
  assert.equal(factory.type, "RED");
});

test("WAITING_FOR_ORDER permanece autoritativo enquanto a conexão MQTT continua ativa", () => {
  let now = 1000;
  const store = new StateStore(testConfig({ TOPIC_STALE_AFTER_MS: "500" }), { clock: () => now });
  store.setMqttState({ connected: true, connecting: false });
  store.observe("f/i/order", JSON.stringify(orderState()), { qos: 0, retain: false });
  now = 60000;

  assert.equal(store.getTopics().find((topic) => topic.topic === "f/i/order").stale, true);
  assert.equal(store.getFactoryOrder().state, "WAITING_FOR_ORDER");
  assert.equal(store.getFactoryOrder().stale, false);
  assert.equal(store.getFactoryOrder().freshnessPolicy, "connection-scoped-event");
});

test("reconexão MQTT exige novo estado de pedido antes de liberar a fábrica", () => {
  const store = new StateStore(testConfig());
  store.setMqttState({ connected: true, connecting: false });
  store.observe("f/i/order", JSON.stringify(orderState()), { qos: 0, retain: false });
  assert.equal(store.getFactoryOrder().stale, false);

  store.setMqttState({ connected: false, connecting: true });
  store.setMqttState({ connected: true, connecting: false });
  assert.equal(store.getFactoryOrder().stale, true);

  store.observe("f/i/order", JSON.stringify(orderState()), { qos: 0, retain: false });
  assert.equal(store.getFactoryOrder().stale, false);
});

test("bootstrap infere WAITING somente após grace, estoque válido e seis estações READY", () => {
  let now = 1000;
  const store = new StateStore(testConfig({
    FACTORY_INFER_WAITING_ON_BOOT: "true",
    FACTORY_BOOTSTRAP_GRACE_MS: "1000",
  }), { clock: () => now });
  store.setMqttState({ connected: true, connecting: false });
  store.observe("f/i/stock", JSON.stringify(stockPayload()), { qos: 0, retain: false });
  observeStations(store);

  assert.equal(store.getFactoryOrder().inferred, false);
  now = 2000;
  const factory = store.getFactoryOrder();
  assert.equal(factory.state, "WAITING_FOR_ORDER");
  assert.equal(factory.valid, true);
  assert.equal(factory.stale, false);
  assert.equal(factory.inferred, true);
  assert.equal(factory.freshnessPolicy, "station-bootstrap");
  assert.equal(factory.inference.stockReady, true);
  assert.deepEqual(factory.inference.missingStations, []);
});

test("bootstrap não infere WAITING com estação ocupada ou evento real na conexão", () => {
  let now = 1000;
  const createStore = () => {
    const store = new StateStore(testConfig({
      FACTORY_INFER_WAITING_ON_BOOT: "true",
      FACTORY_BOOTSTRAP_GRACE_MS: "1000",
    }), { clock: () => now });
    store.setMqttState({ connected: true, connecting: false });
    store.observe("f/i/stock", JSON.stringify(stockPayload()), { qos: 0, retain: false });
    return store;
  };

  const busy = createStore();
  observeStations(busy, { mpo: 2 });
  now = 2000;
  assert.equal(busy.getFactoryOrder().inferred, false);
  assert.deepEqual(busy.getFactoryOrder().inference.notReadyStations, ["mpo"]);

  now = 1000;
  const observed = createStore();
  observeStations(observed);
  observed.observe("f/i/order", JSON.stringify(orderState("IN_PROCESS", "RED")), { qos: 0, retain: false });
  now = 2000;
  assert.equal(observed.getFactoryOrder().inferred, false);
  assert.equal(observed.getFactoryOrder().state, "IN_PROCESS");
  assert.equal(observed.getFactoryOrder().inference.blockedByOrderEvent, true);
});

test("bootstrap é reiniciado com a sessão MQTT", () => {
  let now = 1000;
  const store = new StateStore(testConfig({
    FACTORY_INFER_WAITING_ON_BOOT: "true",
    FACTORY_BOOTSTRAP_GRACE_MS: "1000",
  }), { clock: () => now });
  store.setMqttState({ connected: true, connecting: false });
  store.observe("f/i/stock", JSON.stringify(stockPayload()), { qos: 0, retain: false });
  observeStations(store);
  now = 2000;
  assert.equal(store.getFactoryOrder().inferred, true);

  store.setMqttState({ connected: false, connecting: true });
  store.setMqttState({ connected: true, connecting: false });
  now = 3000;
  assert.equal(store.getFactoryOrder().inferred, false);
  assert.equal(store.getFactoryOrder().inference.stockReady, false);
  assert.deepEqual(store.getFactoryOrder().inference.missingStations, REQUIRED_STATIONS);
});

test("publicação de f/o/order entra no registro de tópicos como outbound", () => {
  const store = new StateStore(testConfig());
  store.recordOutbound("f/o/order", JSON.stringify({ type: "BLUE", ts: "2026-07-21T12:00:00.000Z" }), { qos: 0, retain: false });
  const topic = store.getTopics()[0];
  assert.equal(topic.direction, "outbound");
  assert.equal(topic.outboundCount, 1);
  assert.equal(topic.qos, 0);
  assert.equal(topic.retain, false);
});

test("histórico circular preserva ordem, diagnósticos e respeita limite", () => {
  const store = new StateStore(testConfig({ TOPIC_HISTORY_LIMIT: "3" }));
  for (const state of ["WAITING_FOR_ORDER", "ORDERED", "IN_PROCESS", "IN_PROCESS"]) {
    store.observe("f/i/order", JSON.stringify(orderState(state, state === "WAITING_FOR_ORDER" ? "" : "RED")), { qos: 0, retain: false });
  }
  const events = store.getEvents({ limit: 100 });
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.normalizedPayload.state), ["ORDERED", "IN_PROCESS", "IN_PROCESS"]);
  assert.deepEqual(events.map((event) => event.sequence), [2, 3, 4]);
  assert.equal(events[0].topic, "f/i/order");
  assert.equal(events[0].qos, 0);
  assert.equal(events[0].retain, false);
  assert.equal(typeof events[0].bytes, "number");
  assert.ok(Object.hasOwn(events[0], "rawPayload"));
  assert.ok(Array.isArray(events[0].warnings));
  assert.ok(Array.isArray(events[0].errors));
});

test("histórico não armazena i/cam por padrão", () => {
  const store = new StateStore(testConfig());
  store.observe("i/cam", Buffer.from("imagem-binária"), { qos: 0, retain: false });
  assert.deepEqual(store.getEvents(), []);
});
