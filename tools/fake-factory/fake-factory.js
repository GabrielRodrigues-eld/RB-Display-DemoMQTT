"use strict";

const BROKER_URL = "mqtt://127.0.0.1:1883";
const ORDER_TOPIC = "f/i/order";
const STATUS_TOPIC = "eldorado/demo/factory/order/status";
const VALID_TYPES = Object.freeze(["WHITE", "RED", "BLUE"]);
const FACTORY_OFFSET_MS = 725 * 60 * 1000;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{2}Z$/;

function createFactoryTimestamp(nowMs = Date.now()) {
  return new Date(nowMs + FACTORY_OFFSET_MS).toISOString().replace(/\.(\d{2})\dZ$/, ".$1Z");
}

function validateOrderPayload(rawPayload) {
  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch (error) {
    return { valid: false, reason: "JSON_INVALID", payload: null, error };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, reason: "OBJECT_REQUIRED", payload };
  }

  const keys = Object.keys(payload);
  const exactKeys = keys.length === 2 && keys.includes("type") && keys.includes("ts");
  if (!exactKeys) return { valid: false, reason: "EXACT_KEYS_REQUIRED", payload, keys };
  if (!VALID_TYPES.includes(payload.type)) return { valid: false, reason: "TYPE_INVALID", payload };
  if (typeof payload.ts !== "string" || !TIMESTAMP_PATTERN.test(payload.ts)) {
    return { valid: false, reason: "TIMESTAMP_FORMAT_INVALID", payload };
  }
  if (Number.isNaN(Date.parse(payload.ts))) {
    return { valid: false, reason: "TIMESTAMP_VALUE_INVALID", payload };
  }

  return { valid: true, reason: null, payload, keys };
}

function start() {
  const mqtt = require("mqtt");
  const timers = new Set();
  let shuttingDown = false;

  const client = mqtt.connect(BROKER_URL, {
    protocolVersion: 4,
    clientId: `eldorado-fake-factory-${process.pid}`,
    clean: true,
    keepalive: 30,
    connectTimeout: 8000,
    reconnectPeriod: 2000,
    queueQoSZero: false,
  });

  function log(label, data = "") {
    const suffix = data === "" ? "" : ` ${typeof data === "string" ? data : JSON.stringify(data)}`;
    console.log(`[${new Date().toISOString()}] ${label}${suffix}`);
  }

  function publishStatus(message) {
    if (!client.connected) {
      log("STATUS NÃO PUBLICADO: broker desconectado", message);
      return;
    }
    const serialized = JSON.stringify(message);
    client.publish(STATUS_TOPIC, serialized, { qos: 0, retain: false }, (error) => {
      if (error) console.error(`[${new Date().toISOString()}] ERRO AO PUBLICAR STATUS`, error);
      else log(`STATUS ${message.status}`, serialized);
    });
  }

  function schedule(delayMs, callback) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!shuttingDown) callback();
    }, delayMs);
    timers.add(timer);
  }

  client.on("connect", () => {
    log("CONECTADO", BROKER_URL);
    client.subscribe(ORDER_TOPIC, { qos: 0 }, (error, granted) => {
      if (error) console.error(`[${new Date().toISOString()}] ERRO AO ASSINAR`, error);
      else log("ASSINATURA ATIVA", granted);
    });
  });

  client.on("reconnect", () => log("RECONECTANDO EM 2 s"));
  client.on("offline", () => log("BROKER OFFLINE"));
  client.on("close", () => {
    if (!shuttingDown) log("CONEXÃO FECHADA");
  });
  client.on("error", (error) => console.error(`[${new Date().toISOString()}] ERRO MQTT`, error));

  client.on("message", (topic, buffer) => {
    const rawPayload = buffer.toString("utf8");
    const result = validateOrderPayload(rawPayload);
    log("ORDEM RECEBIDA", { topic, rawPayload });
    log(result.valid ? "VALIDAÇÃO OK" : "VALIDAÇÃO FALHOU", {
      reason: result.reason,
      keys: result.keys || Object.keys(result.payload || {}),
    });

    if (!result.valid) {
      publishStatus({
        status: "REJECTED",
        reason: "INVALID_PAYLOAD",
        type: null,
        ts: createFactoryTimestamp(),
      });
      return;
    }

    const { type, ts } = result.payload;
    publishStatus({ status: "RECEIVED", type, ts });
    schedule(700, () => publishStatus({ status: "ACCEPTED", type, ts }));
    schedule(8500, () => publishStatus({ status: "COMPLETED", type, ts }));
  });

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`ENCERRANDO (${signal})`);
    timers.forEach(clearTimeout);
    timers.clear();
    client.end(false, {}, () => {
      log("DESCONECTADO COM SEGURANÇA");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 3000).unref();
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  return client;
}

module.exports = {
  FACTORY_OFFSET_MS,
  TIMESTAMP_PATTERN,
  VALID_TYPES,
  createFactoryTimestamp,
  validateOrderPayload,
  start,
};

if (require.main === module) start();
