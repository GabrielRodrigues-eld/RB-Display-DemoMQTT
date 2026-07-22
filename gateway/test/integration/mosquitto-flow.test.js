"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");
const { createGateway } = require("../../src/server");
const { createFakeFactory } = require("../../src/simulation/fake-factory");
const { silentLogger, testConfig, waitFor } = require("../helpers");

function findMosquitto() {
  const candidates = [
    process.env.MOSQUITTO_EXE,
    "C:\\Program Files\\mosquitto\\mosquitto.exe",
    "/usr/sbin/mosquitto",
    "/usr/local/sbin/mosquitto",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPort(port) {
  return waitFor(() => new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  }), 3000, 25);
}

for (const emitShipped of [false, true]) {
test(`API -> gateway -> Mosquitto -> fake factory -> gateway ${emitShipped ? "com" : "sem"} SHIPPED`, { timeout: 15000 }, async (t) => {
  const executable = findMosquitto();
  if (!executable) {
    t.skip("Mosquitto não está instalado; defina MOSQUITTO_EXE ou instale-o para executar este teste.");
    return;
  }
  const mqttPort = await freePort();
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "factory-24v-test-"));
  const configPath = path.join(tempDirectory, "mosquitto.conf");
  fs.writeFileSync(configPath, `persistence false\nlog_type all\nlistener ${mqttPort} 127.0.0.1\nprotocol mqtt\nallow_anonymous true\n`, "utf8");
  const broker = spawn(executable, ["-c", configPath, "-v"], { stdio: "ignore", windowsHide: true });
  t.after(() => {
    broker.kill();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });
  await waitForPort(mqttPort);

  const base = testConfig({
    MODE: "simulation",
    MQTT_URL: `mqtt://127.0.0.1:${mqttPort}`,
    SIMULATION_SPEED: "8",
    SIMULATION_SNAPSHOT_PERIOD_MS: "300",
    SIMULATION_EMIT_SHIPPED: String(emitShipped),
  });
  const config = { ...base, app: { ...base.app, port: 0 } };
  const logger = silentLogger();
  const gateway = createGateway({ config, logger });
  const factory = createFakeFactory({ config, logger, scenario: "normal", speed: 8 });
  factory.start();
  await gateway.start();
  t.after(async () => {
    await gateway.stop();
    await factory.stop();
  });

  await waitFor(() => gateway.store.mqtt.connected && gateway.store.getFactoryOrder().state === "WAITING_FOR_ORDER" && gateway.store.getStock().valid, 5000);
  const initialBlue = gateway.store.getStock().counts.BLUE;
  const origin = `http://127.0.0.1:${gateway.server.address().port}`;
  const wsEvents = [];
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/events`);
  socket.on("message", (data) => wsEvents.push(JSON.parse(data.toString("utf8"))));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  t.after(() => socket.close());

  const response = await fetch(`${origin}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "BLUE" }),
  });
  assert.equal(response.status, 202);

  await waitFor(() => gateway.store.getOrderState().last?.type === "BLUE" && gateway.store.getOrderState().status === "idle", 8000);
  assert.equal(gateway.store.getStock().counts.BLUE, initialBlue - 1);
  const transitionStates = gateway.store.getOrderState().last.transitions.map((item) => item.status);
  assert.ok(transitionStates.includes("ordered"));
  assert.ok(transitionStates.includes("in_process"));
  assert.equal(transitionStates.includes("shipped"), emitShipped);
  assert.equal(gateway.store.getOrderState().last.completedWithoutShipped, !emitShipped);
  assert.ok(wsEvents.some((event) => event.event === "order-state"));
  const topics = await fetch(`${origin}/api/topics`).then((result) => result.json());
  assert.ok(topics.topics.some((topic) => topic.topic === "f/o/order" && topic.qos === 0 && topic.retain === false));
});
}
