"use strict";

const fs = require("node:fs");
const path = require("node:path");

const GATEWAY_ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.resolve(GATEWAY_ROOT, "..");

function parseEnvText(text) {
  const values = {};
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readEnvFile(filePath = path.join(GATEWAY_ROOT, ".env")) {
  if (!fs.existsSync(filePath)) return {};
  return parseEnvText(fs.readFileSync(filePath, "utf8"));
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseNumber(name, value, fallback, { min = 0, max = Number.POSITIVE_INFINITY, integer = true } = {}) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${name} possui valor inválido: ${value}`);
  }
  return parsed;
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function createConfig(overrides = {}, envFilePath) {
  const env = { ...readEnvFile(envFilePath), ...process.env, ...overrides };
  const mode = String(env.MODE || "simulation").toLowerCase();
  if (!["simulation", "factory", "test"].includes(mode)) {
    throw new Error(`MODE deve ser simulation, factory ou test; recebido: ${mode}`);
  }

  const mqttUrl = env.MQTT_URL || (mode === "simulation" || mode === "test" ? "mqtt://127.0.0.1:1883" : "");
  if (!mqttUrl) throw new Error("MQTT_URL é obrigatório no modo factory.");
  let parsedMqttUrl;
  try {
    parsedMqttUrl = new URL(mqttUrl);
  } catch (_error) {
    throw new Error("MQTT_URL é inválida.");
  }
  if (!["mqtt:", "mqtts:"].includes(parsedMqttUrl.protocol)) {
    throw new Error("MQTT_URL do gateway deve usar mqtt:// ou mqtts://.");
  }

  const extraSubscriptions = splitList(env.MQTT_EXTRA_SUBSCRIPTIONS);
  const forbidden = extraSubscriptions.filter((topic) => topic.startsWith("fl/") || topic.startsWith("c/") || topic.startsWith("f/o/"));
  if (forbidden.length) {
    throw new Error(`MQTT_EXTRA_SUBSCRIPTIONS contém tópicos fora do escopo: ${forbidden.join(", ")}`);
  }

  return Object.freeze({
    app: Object.freeze({
      host: env.APP_HOST || "0.0.0.0",
      port: parseNumber("APP_PORT", env.APP_PORT, 8080, { min: 1 }),
      webRoot: WEB_ROOT,
    }),
    mode,
    mqtt: Object.freeze({
      url: mqttUrl,
      username: env.MQTT_USERNAME || "",
      password: env.MQTT_PASSWORD || "",
      clientIdPrefix: env.MQTT_CLIENT_ID_PREFIX || "eldorado-factory-gateway",
      protocolVersion: parseNumber("MQTT_PROTOCOL_VERSION", env.MQTT_PROTOCOL_VERSION, 4, { min: 3 }),
      keepaliveSeconds: parseNumber("MQTT_KEEPALIVE_SECONDS", env.MQTT_KEEPALIVE_SECONDS, 30, { min: 1 }),
      reconnectPeriodMs: parseNumber("MQTT_RECONNECT_PERIOD_MS", env.MQTT_RECONNECT_PERIOD_MS, 2000, { min: 0 }),
      orderTopic: env.MQTT_ORDER_TOPIC || "f/o/order",
      orderStateTopic: env.MQTT_ORDER_STATE_TOPIC || "f/i/order",
      stockTopic: env.MQTT_STOCK_TOPIC || "f/i/stock",
      stationStateTopic: env.MQTT_STATION_STATE_TOPIC || "f/i/state/+",
      enableEnvironmentTopics: parseBoolean(env.MQTT_ENABLE_ENVIRONMENT_TOPICS, true),
      enableCameraTopic: parseBoolean(env.MQTT_ENABLE_CAMERA_TOPIC, false),
      enableRawDiagnostics: parseBoolean(env.MQTT_ENABLE_RAW_DIAGNOSTICS, true),
      extraSubscriptions: Object.freeze(extraSubscriptions),
    }),
    timing: Object.freeze({
      orderAcceptanceTimeoutMs: parseNumber("ORDER_ACCEPTANCE_TIMEOUT_MS", env.ORDER_ACCEPTANCE_TIMEOUT_MS, 10000, { min: 100 }),
      stockStaleAfterMs: parseNumber("STOCK_STALE_AFTER_MS", env.STOCK_STALE_AFTER_MS, 30000, { min: 100 }),
      topicStaleAfterMs: parseNumber("TOPIC_STALE_AFTER_MS", env.TOPIC_STALE_AFTER_MS, 30000, { min: 100 }),
    }),
    order: Object.freeze({
      commandsEnabled: parseBoolean(env.FACTORY_COMMANDS_ENABLED, mode !== "factory"),
      timestampOffsetMinutes: parseNumber(
        "ORDER_TIMESTAMP_OFFSET_MINUTES",
        env.ORDER_TIMESTAMP_OFFSET_MINUTES,
        0,
        { min: -1440, max: 1440 },
      ),
    }),
    factory: Object.freeze({
      inferWaitingOnBoot: parseBoolean(env.FACTORY_INFER_WAITING_ON_BOOT, false),
      bootstrapGraceMs: parseNumber("FACTORY_BOOTSTRAP_GRACE_MS", env.FACTORY_BOOTSTRAP_GRACE_MS, 6000, { min: 1000 }),
      requiredReadyStations: Object.freeze(["dsi", "dso", "hbw", "mpo", "vgr", "sld"]),
    }),
    observability: Object.freeze({
      topicHistoryLimit: parseNumber("TOPIC_HISTORY_LIMIT", env.TOPIC_HISTORY_LIMIT, 100, { min: 1, max: 10000 }),
    }),
    simulation: Object.freeze({
      scenario: env.SIMULATION_SCENARIO || "normal",
      speed: parseNumber("SIMULATION_SPEED", env.SIMULATION_SPEED, 1, { min: 0.01, integer: false }),
      snapshotPeriodMs: parseNumber("SIMULATION_SNAPSHOT_PERIOD_MS", env.SIMULATION_SNAPSHOT_PERIOD_MS, 2000, { min: 250 }),
      emitShipped: parseBoolean(env.SIMULATION_EMIT_SHIPPED, false),
    }),
  });
}

function redactMqttUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch (_error) {
    return "[URL MQTT INVÁLIDA]";
  }
}

function sanitizedConfig(config) {
  return {
    mode: config.mode,
    app: config.app,
    mqtt: {
      ...config.mqtt,
      url: redactMqttUrl(config.mqtt.url),
      password: config.mqtt.password ? "[CONFIGURADA]" : "",
      username: config.mqtt.username ? "[CONFIGURADO]" : "",
    },
    timing: config.timing,
    order: config.order,
    factory: config.factory,
    observability: config.observability,
    simulation: config.simulation,
  };
}

module.exports = { GATEWAY_ROOT, WEB_ROOT, createConfig, parseEnvText, redactMqttUrl, sanitizedConfig };
