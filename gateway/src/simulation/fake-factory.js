"use strict";

const mqtt = require("mqtt");
const { createConfig, redactMqttUrl } = require("../config");
const { createLogger } = require("../logger");
const { LOCATIONS, VALID_TYPES, isIsoUtc, isPlainObject } = require("../validators");

const STATIONS = Object.freeze(["hbw", "vgr", "mpo", "sld", "dsi", "dso"]);
const SCENARIOS = Object.freeze([
  "normal",
  "no-stock",
  "slow-order",
  "drop-order",
  "mqtt-disconnect",
  "malformed-order-state",
  "malformed-stock",
  "unknown-order-state",
  "station-error",
  "duplicate-message",
  "retained-old-message",
  "out-of-order-state",
  "stale-stock",
]);

function physicalEmptyWorkpiece() {
  return { id: "0", state: "", type: "" };
}

function createInitialStock(scenario) {
  const pieces = scenario === "no-stock"
    ? []
    : [
        ["A1", "WHITE", "W-001"],
        ["A2", "RED", "R-001"],
        ["A3", "BLUE", "B-001"],
        ["B1", "WHITE", "W-002"],
        ["B2", "RED", "R-002"],
        ["B3", "BLUE", "B-002"],
      ];
  const byLocation = new Map(pieces.map(([location, type, id]) => [location, { id, type, state: "RAW" }]));
  return LOCATIONS.map((location) => ({
    location,
    workpiece: byLocation.get(location) || physicalEmptyWorkpiece(),
  }));
}

function validateFactoryOrder(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (_error) {
    return { ok: false, reason: "JSON_INVALID" };
  }
  if (!isPlainObject(value)) return { ok: false, reason: "OBJECT_REQUIRED" };
  const keys = Object.keys(value);
  if (keys.length !== 2 || keys[0] !== "type" || keys[1] !== "ts") return { ok: false, reason: "EXACT_KEYS_REQUIRED" };
  if (!VALID_TYPES.includes(value.type)) return { ok: false, reason: "TYPE_INVALID" };
  if (!isIsoUtc(value.ts)) return { ok: false, reason: "TIMESTAMP_INVALID" };
  return { ok: true, value };
}

function createFakeFactory(options = {}) {
  const config = options.config || createConfig();
  const logger = options.logger || createLogger();
  if (config.mode === "factory" && options.allowFactoryBroker !== true) {
    throw new Error("O simulador recusou MODE=factory para não publicar dados falsos no broker físico.");
  }
  const scenario = options.scenario || config.simulation.scenario;
  if (!SCENARIOS.includes(scenario)) throw new Error(`SIMULATION_SCENARIO inválido: ${scenario}`);
  const speed = options.speed || config.simulation.speed;
  const emitShipped = options.emitShipped ?? config.simulation.emitShipped;
  const mqttConnect = options.mqttConnect || mqtt.connect;
  const stockItems = createInitialStock(scenario);
  const timers = new Set();
  const stationStates = new Map();
  let client = null;
  let orderState = { state: "WAITING_FOR_ORDER", type: "" };
  let processing = false;
  let snapshotTimer = null;
  let processingStateTimer = null;
  let shuttingDown = false;

  function delay(ms) {
    return Math.max(1, Math.round(ms / speed));
  }

  function schedule(ms, callback) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!shuttingDown) callback();
    }, delay(ms));
    timers.add(timer);
    return timer;
  }

  function publish(topic, value, publishOptions = {}) {
    if (!client?.connected) {
      logger.warn("simulation", "Publicação simulada descartada: MQTT offline", { topic });
      return;
    }
    const payload = typeof value === "string" ? value : JSON.stringify(value);
    const optionsMqtt = { qos: 0, retain: false, ...publishOptions };
    client.publish(topic, payload, optionsMqtt, (error) => {
      if (error) logger.error("simulation", "Falha ao publicar evento simulado", { topic, error });
      else logger.info("simulation", "Evento publicado", { scenario, topic, qos: optionsMqtt.qos, retain: optionsMqtt.retain, payload });
    });
    if (scenario === "duplicate-message" && !publishOptions.noDuplicate) {
      client.publish(topic, payload, optionsMqtt);
      logger.warn("simulation", "Mensagem duplicada intencionalmente", { topic });
    }
  }

  function publishOrderState(state, type = orderState.type, optionsMqtt) {
    orderState = { state, type: type || "" };
    publish(config.mqtt.orderStateTopic, { ts: new Date().toISOString(), state, type: type || "" }, optionsMqtt);
  }

  function stockPayload() {
    return { ts: new Date().toISOString(), stockItems };
  }

  function publishStock() {
    if (scenario === "malformed-stock") {
      publish(config.mqtt.stockTopic, "{malformed-stock", { noDuplicate: true });
      return;
    }
    publish(config.mqtt.stockTopic, stockPayload());
  }

  function publishStation(station, code, description, stateOptions = {}) {
    const stationState = {
      station,
      code,
      description,
      active: stateOptions.active ?? (code === 1 ? false : code !== 0),
      target: stateOptions.target ?? (code === 1 ? "" : station),
    };
    stationStates.set(station, stationState);
    publish(`f/i/state/${station}`, { ts: new Date().toISOString(), ...stationState });
  }

  function publishStationSnapshots() {
    for (const stationState of stationStates.values()) {
      publish(`f/i/state/${stationState.station}`, { ts: new Date().toISOString(), ...stationState });
    }
  }

  function allReady() {
    for (const station of STATIONS) {
      const error = scenario === "station-error" && station === "vgr";
      publishStation(station, error ? 4 : 1, error ? "Erro simulado no VGR" : "", {
        active: error,
        target: error ? station : "",
      });
    }
  }

  function removeFromStock(type) {
    const item = stockItems.find((candidate) => candidate.workpiece?.type === type);
    if (!item) return false;
    item.workpiece = physicalEmptyWorkpiece();
    return true;
  }

  function beginNormalCycle(type) {
    processing = true;
    const slowMultiplier = scenario === "slow-order" ? 12 : 1;
    schedule(250 * slowMultiplier, () => {
      publishOrderState("ORDERED", type);
      publishStation("vgr", 2, "Retirando peça do estoque");
      publishStation("hbw", 2, "Atendendo pedido");
    });
    schedule(1200 * slowMultiplier, () => {
      publishOrderState("IN_PROCESS", type);
      clearInterval(processingStateTimer);
      processingStateTimer = setInterval(() => publishOrderState("IN_PROCESS", type), delay(1000));
      processingStateTimer.unref?.();
      publishStation("hbw", 1, "", { active: false, target: "" });
      publishStation("vgr", 1, "", { active: false, target: "" });
      publishStation("mpo", 2, "Processando peça");
    });
    schedule(2500 * slowMultiplier, () => {
      if (emitShipped) publishOrderState("SHIPPED", type);
      publishStation("mpo", 1, "", { active: false, target: "" });
      publishStation("dso", 2, "Peça na saída");
      removeFromStock(type);
      publishStock();
    });
    schedule(3200 * slowMultiplier, () => {
      clearInterval(processingStateTimer);
      processingStateTimer = null;
      allReady();
      publishOrderState("WAITING_FOR_ORDER", "");
      processing = false;
      schedule(120, () => publishOrderState("WAITING_FOR_ORDER", ""));
    });
  }

  function handleOrder(raw) {
    const validated = validateFactoryOrder(raw);
    logger.info("simulation", "Pedido recebido pelo simulador", { raw, validated, state: orderState.state });
    if (!validated.ok || processing || orderState.state !== "WAITING_FOR_ORDER") {
      logger.warn("simulation", "Pedido ignorado pelo simulador", { reason: validated.reason || "FACTORY_NOT_READY" });
      return;
    }
    const type = validated.value.type;
    if (!stockItems.some((item) => item.workpiece?.type === type)) {
      logger.warn("simulation", "Pedido ignorado por falta de estoque", { type });
      return;
    }
    if (scenario === "drop-order") {
      logger.warn("simulation", "Pedido descartado intencionalmente", { type });
      return;
    }
    if (scenario === "mqtt-disconnect") {
      logger.warn("simulation", "Simulador desconectando intencionalmente", { type });
      client.end(true);
      return;
    }
    if (scenario === "malformed-order-state") {
      publish(config.mqtt.orderStateTopic, "{malformed-order-state", { noDuplicate: true });
      return;
    }
    if (scenario === "unknown-order-state") {
      publish(config.mqtt.orderStateTopic, { ts: new Date().toISOString(), state: "MAINTENANCE", type });
      return;
    }
    if (scenario === "out-of-order-state") {
      publishOrderState("SHIPPED", type);
      schedule(300, () => publishOrderState("ORDERED", type));
      schedule(900, () => publishOrderState("WAITING_FOR_ORDER", ""));
      return;
    }
    beginNormalCycle(type);
  }

  function publishInitialState() {
    if (scenario === "retained-old-message") {
      publish(config.mqtt.orderStateTopic, {
        ts: new Date(Date.now() - 3600000).toISOString(),
        state: "ORDERED",
        type: "RED",
      }, { retain: true, noDuplicate: true });
    }
    publishOrderState("WAITING_FOR_ORDER", "", { retain: false, noDuplicate: true });
    publishStock();
    allReady();
  }

  function start() {
    logger.info("simulation", "Iniciando fábrica simulada", { scenario, speed, emitShipped, broker: redactMqttUrl(config.mqtt.url) });
    client = mqttConnect(config.mqtt.url, {
      protocolVersion: config.mqtt.protocolVersion,
      clientId: `eldorado-fake-factory-24v-${process.pid}`,
      clean: true,
      keepalive: config.mqtt.keepaliveSeconds,
      reconnectPeriod: config.mqtt.reconnectPeriodMs,
      connectTimeout: 8000,
      queueQoSZero: false,
      username: config.mqtt.username || undefined,
      password: config.mqtt.password || undefined,
    });
    client.on("connect", () => {
      logger.info("simulation", "Simulador conectado ao MQTT", { broker: redactMqttUrl(config.mqtt.url) });
      client.subscribe(config.mqtt.orderTopic, { qos: 0 }, (error) => {
        if (error) logger.error("simulation", "Falha ao assinar pedidos", { error });
        else publishInitialState();
      });
      clearInterval(snapshotTimer);
      snapshotTimer = setInterval(() => {
        if (scenario !== "stale-stock") publishStock();
        publishStationSnapshots();
      }, config.simulation.snapshotPeriodMs);
      snapshotTimer.unref?.();
    });
    client.on("message", (topic, payload) => {
      if (topic === config.mqtt.orderTopic) handleOrder(payload.toString("utf8"));
    });
    client.on("error", (error) => logger.error("simulation", "Erro MQTT no simulador", { error }));
    client.on("offline", () => logger.warn("simulation", "Simulador MQTT offline"));
    return client;
  }

  async function stop() {
    shuttingDown = true;
    clearInterval(snapshotTimer);
    clearInterval(processingStateTimer);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (client) await new Promise((resolve) => client.end(false, {}, resolve));
  }

  return { emitShipped, get client() { return client; }, get orderState() { return { ...orderState }; }, scenario, start, stockItems, stop };
}

async function main() {
  const factory = createFakeFactory();
  factory.start();
  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`[${new Date().toISOString()}] [SIMULATION EVENT] Encerrando por ${signal}`);
    await factory.stop();
    process.exit(0);
  }
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[${new Date().toISOString()}] [ERROR] [SIMULATION EVENT] Simulador não iniciou`, error);
    process.exit(1);
  });
}

module.exports = { SCENARIOS, createFakeFactory, createInitialStock, physicalEmptyWorkpiece, validateFactoryOrder };
