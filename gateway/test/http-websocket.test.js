"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const { createGateway } = require("../src/server");
const { FakeMqttClient, orderState, silentLogger, stockPayload, testConfig, waitFor } = require("./helpers");

test("HTTP serve web app/API e WebSocket recebe snapshot e atualização", async (t) => {
  const mqttClient = new FakeMqttClient();
  const warnings = [];
  const logger = {
    ...silentLogger(),
    warn(category, message, data) {
      warnings.push({ category, message, data });
    },
  };
  const gateway = createGateway({
    config: testConfig({ ORDER_TIMESTAMP_OFFSET_MINUTES: "725" }),
    logger,
    mqttClient,
  });
  await gateway.start();
  t.after(async () => gateway.stop());
  const port = gateway.server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const html = await fetch(`${origin}/`).then((response) => response.text());
  assert.match(html, /gateway-service\.js/);
  assert.doesNotMatch(html, /mqtt\.min\.js/);

  const health = await fetch(`${origin}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.processOnline, true);
  assert.equal(health.orderTimestampOffsetMinutes, 725);
  assert.ok(warnings.some((warning) => warning.category === "warning"
    && warning.data?.orderTimestampOffsetMinutes === 725));

  const messages = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/events`);
  socket.on("message", (data) => messages.push(JSON.parse(data.toString("utf8"))));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const snapshot = await waitFor(() => messages.find((message) => message.event === "snapshot"));
  assert.equal(snapshot.data.gateway.orderTimestampOffsetMinutes, 725);

  gateway.store.observe("f/i/stock", JSON.stringify(stockPayload()), { qos: 0, retain: false });
  const stockEvent = await waitFor(() => messages.find((message) => message.event === "stock-state"));
  assert.equal(stockEvent.data.counts.WHITE, 1);

  socket.close();
  await new Promise((resolve) => socket.once("close", resolve));
});

test("POST /api/orders retorna erro estruturado e aceita pedido pronto", async (t) => {
  const mqttClient = new FakeMqttClient();
  const gateway = createGateway({ config: testConfig(), logger: silentLogger(), mqttClient });
  await gateway.start();
  t.after(async () => gateway.stop());
  await waitFor(() => gateway.store.mqtt.connected);
  const origin = `http://127.0.0.1:${gateway.server.address().port}`;

  let response = await fetch(`${origin}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "GREEN" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_TYPE");

  gateway.store.observe("f/i/order", JSON.stringify(orderState()), { qos: 0, retain: false });
  gateway.store.observe("f/i/stock", JSON.stringify(stockPayload()), { qos: 0, retain: false });
  response = await fetch(`${origin}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "BLUE" }),
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(mqttClient.published.length, 1);

  const topics = await fetch(`${origin}/api/topics`).then((result) => result.json());
  assert.ok(topics.topics.some((topic) => topic.topic === "f/o/order" && topic.direction === "outbound"));
  const events = await fetch(`${origin}/api/events?limit=2`).then((result) => result.json());
  assert.equal(events.ok, true);
  assert.equal(events.limit, 2);
  assert.equal(events.events.length, 2);
  gateway.orderService.close();
});

test("factory read-only mantém leitura e bloqueia POST /api/orders", async (t) => {
  const mqttClient = new FakeMqttClient();
  const gateway = createGateway({
    config: testConfig({ MODE: "factory", MQTT_URL: "mqtt://192.168.0.10:1883", FACTORY_COMMANDS_ENABLED: "false" }),
    logger: silentLogger(),
    mqttClient,
  });
  await gateway.start();
  t.after(async () => gateway.stop());
  await waitFor(() => gateway.store.mqtt.connected);
  gateway.store.observe("f/i/order", JSON.stringify(orderState()), { qos: 0, retain: false });
  gateway.store.observe("f/i/stock", JSON.stringify(stockPayload()), { qos: 0, retain: false });
  const origin = `http://127.0.0.1:${gateway.server.address().port}`;

  assert.equal((await fetch(`${origin}/api/state`).then((response) => response.json())).state.gateway.commandsEnabled, false);
  assert.equal((await fetch(`${origin}/api/stock`).then((response) => response.json())).ok, true);
  assert.equal((await fetch(`${origin}/api/topics`).then((response) => response.json())).ok, true);
  assert.equal((await fetch(`${origin}/api/events`).then((response) => response.json())).ok, true);

  const response = await fetch(`${origin}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "WHITE" }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "FACTORY_COMMANDS_DISABLED",
    message: "Comandos físicos estão desabilitados neste gateway.",
    details: { mode: "factory" },
  });
  assert.equal(mqttClient.published.length, 0);
});
