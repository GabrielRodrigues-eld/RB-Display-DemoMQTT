"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createConfig, sanitizedConfig } = require("./config");
const { EventHub } = require("./event-hub");
const { createLogger } = require("./logger");
const { FactoryMqttClient } = require("./mqtt-client");
const { OrderError, OrderService } = require("./order-service");
const { StateStore } = require("./state-store");

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
});

const STATIC_FILES = Object.freeze({
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/config.js": "config.js",
  "/gateway-service.js": "gateway-service.js",
  "/app.js": "app.js",
});

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendError(response, statusCode, code, message, details = {}) {
  sendJson(response, statusCode, { ok: false, code, message, details });
}

async function readJsonBody(request, limit = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Corpo da requisição excede o limite.");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch (_error) {
    const error = new Error("O corpo deve conter JSON válido.");
    error.code = "INVALID_JSON";
    throw error;
  }
}

function resolveStaticFile(webRoot, pathname) {
  if (STATIC_FILES[pathname]) return path.join(webRoot, STATIC_FILES[pathname]);
  if (/^\/assets\/[A-Za-z0-9._-]+$/.test(pathname)) {
    return path.join(webRoot, "assets", path.basename(pathname));
  }
  return null;
}

function serveStatic(webRoot, pathname, response) {
  const filePath = resolveStaticFile(webRoot, pathname);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const extension = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  response.writeHead(200, {
    "content-type": MIME_TYPES[extension] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": extension === ".html" ? "no-store" : "public, max-age=300",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  fs.createReadStream(filePath).pipe(response);
  return true;
}

function createGateway(options = {}) {
  const config = options.config || createConfig();
  const logger = options.logger || createLogger();
  const store = options.store || new StateStore(config, options.storeOptions);
  const mqttClient = options.mqttClient || new FactoryMqttClient(config, logger, options.mqttOptions);
  const orderService = options.orderService || new OrderService(config, store, mqttClient, logger, options.orderOptions);
  let hub;
  let bootstrapTimer = null;
  let lastFactoryPresentationSignature = null;

  function stateSnapshot() {
    return {
      ...store.getState(),
      gateway: {
        online: true,
        mode: config.mode,
        commandsEnabled: config.order.commandsEnabled,
        inferWaitingOnBoot: config.factory.inferWaitingOnBoot,
        bootstrapGraceMs: config.factory.bootstrapGraceMs,
        orderTimestampOffsetMinutes: config.order.timestampOffsetMinutes,
        uptimeSeconds: process.uptime(),
        websocketClients: hub?.clientCount || 0,
      },
    };
  }

  hub = new EventHub({ getSnapshot: stateSnapshot, logger });

  function broadcastFactoryPresentation(state = store.getFactoryOrder()) {
    const signature = JSON.stringify({
      state: state.state,
      valid: state.valid,
      stale: state.stale,
      inferred: state.inferred,
      freshnessPolicy: state.freshnessPolicy,
      connectionGeneration: state.connectionGeneration,
    });
    if (signature === lastFactoryPresentationSignature) return;
    lastFactoryPresentationSignature = signature;
    hub.broadcast("factory-order-state", state);
  }

  function scheduleBootstrapEvaluation(mqttState) {
    clearTimeout(bootstrapTimer);
    bootstrapTimer = null;
    if (!mqttState.connected || !config.factory.inferWaitingOnBoot) return;
    bootstrapTimer = setTimeout(() => broadcastFactoryPresentation(), config.factory.bootstrapGraceMs + 25);
    bootstrapTimer.unref?.();
  }

  mqttClient.on("state", (state) => {
    store.setMqttState(state);
    scheduleBootstrapEvaluation(store.getMqttState());
    broadcastFactoryPresentation();
  });
  mqttClient.on("message", (topic, payload, packet) => {
    const observation = store.observe(topic, payload, packet);
    const retainedOrderState = observation.kind === "order-state" && observation.record.retain;
    if (observation.parseError || (observation.schema && !observation.schema.ok) || retainedOrderState) {
      logger.warn("unknown", "Payload MQTT preservado para diagnóstico", {
        topic,
        parseError: observation.parseError,
        schemaErrors: retainedOrderState ? ["f/i/order retained não é usado para controle"] : observation.schema?.errors || [],
        raw: config.mqtt.enableRawDiagnostics ? observation.record.lastPayloadRaw : "[DESABILITADO]",
      });
      hub.broadcast("integration-warning", {
        code: observation.parseError ? "MQTT_JSON_INVALID" : retainedOrderState ? "RETAINED_ORDER_STATE_IGNORED" : "MQTT_SCHEMA_UNKNOWN",
        topic,
        diagnostics: observation.record,
      });
    } else {
      logger.info("observed", "Mensagem MQTT observada", {
        topic,
        qos: observation.record.qos,
        retain: observation.record.retain,
        bytes: observation.record.bytes,
      });
    }
  });
  mqttClient.on("subscription-error", (detail) => hub.broadcast("integration-warning", { code: "MQTT_SUBSCRIPTION_FAILED", topic: detail.topic }));
  mqttClient.on("order-published", (detail) => {
    store.recordOutbound(detail.topic, detail.payload, { qos: detail.qos, retain: detail.retain });
  });

  store.on("factory-order-state", (state) => {
    orderService.handleFactoryState(state);
    lastFactoryPresentationSignature = null;
    broadcastFactoryPresentation(state);
  });
  store.on("order-state", (state) => hub.broadcast("order-state", state));
  store.on("stock-state", (state) => {
    hub.broadcast("stock-state", state);
    broadcastFactoryPresentation();
  });
  store.on("station-state", (state) => {
    hub.broadcast("station-state", state);
    broadcastFactoryPresentation();
  });
  store.on("mqtt-state", (state) => hub.broadcast("mqtt-state", state));
  store.on("topic-message", (observation) => {
    const data = {
      topic: observation.topic,
      kind: observation.kind,
      receivedAt: observation.receivedAt,
      diagnostics: observation.record,
    };
    if (!config.mqtt.enableRawDiagnostics) data.diagnostics.lastPayloadRaw = null;
    hub.broadcast("topic-message", data);
  });
  orderService.on("integration-warning", (warning) => hub.broadcast("integration-warning", warning));

  const server = http.createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    let url;
    try {
      url = new URL(request.url, "http://gateway.local");
    } catch (_error) {
      sendError(response, 400, "INVALID_URL", "URL inválida.");
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          processOnline: true,
          mode: config.mode,
          commandsEnabled: config.order.commandsEnabled,
          inferWaitingOnBoot: config.factory.inferWaitingOnBoot,
          bootstrapGraceMs: config.factory.bootstrapGraceMs,
          orderTimestampOffsetMinutes: config.order.timestampOffsetMinutes,
          mqttConnected: store.mqtt.connected,
          uptimeSeconds: process.uptime(),
          websocketClients: hub.clientCount,
          lastMqttError: store.mqtt.lastError,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        sendJson(response, 200, { ok: true, state: stateSnapshot() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/stock") {
        sendJson(response, 200, { ok: true, stock: store.getStock() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/topics") {
        sendJson(response, 200, { ok: true, topics: store.getTopics() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        const requestedLimit = url.searchParams.has("limit")
          ? Number(url.searchParams.get("limit"))
          : config.observability.topicHistoryLimit;
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
          sendError(response, 400, "INVALID_LIMIT", "limit deve ser um inteiro positivo.");
          return;
        }
        const events = store.getEvents({ limit: requestedLimit });
        sendJson(response, 200, {
          ok: true,
          limit: Math.min(requestedLimit, config.observability.topicHistoryLimit),
          totalStored: store.events.length,
          events,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/orders") {
        const body = await readJsonBody(request);
        const result = await orderService.requestOrder(body, {
          remoteAddress: request.socket.remoteAddress,
          userAgent: request.headers["user-agent"],
        });
        sendJson(response, 202, result);
        return;
      }
      if (request.method === "GET" && serveStatic(config.app.webRoot, url.pathname, response)) return;
      sendError(response, 404, "NOT_FOUND", "Recurso não encontrado.");
    } catch (error) {
      if (error instanceof OrderError) {
        sendError(response, error.statusCode, error.code, error.message, error.details);
      } else if (error.code === "INVALID_JSON" || error.code === "BODY_TOO_LARGE") {
        sendError(response, error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code, error.message);
      } else {
        logger.error("system", "Erro não tratado na requisição HTTP", { error, method: request.method, path: url.pathname });
        sendError(response, 500, "INTERNAL_ERROR", "Erro interno do gateway.");
      }
    }
  });

  server.on("upgrade", (request, socket, head) => hub.handleUpgrade(request, socket, head));
  server.on("clientError", (error, socket) => {
    logger.warn("warning", "Erro de cliente HTTP", { error });
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  const statePulse = setInterval(() => hub.broadcast("gateway-state", stateSnapshot()), 5000);
  statePulse.unref?.();

  async function start() {
    mqttClient.connect();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.app.port, config.app.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    logger.info("system", "Gateway HTTP/WebSocket iniciado", {
      address: `http://${config.app.host}:${server.address().port}`,
      mode: config.mode,
      config: sanitizedConfig(config),
    });
    if (config.order.timestampOffsetMinutes !== 0) {
      logger.warn("warning", "Compatibilidade de relógio ativada: o ts MQTT não representa o UTC real", {
        orderTimestampOffsetMinutes: config.order.timestampOffsetMinutes,
        remediation: "Defina ORDER_TIMESTAMP_OFFSET_MINUTES=0 e reinicie o gateway após corrigir/confirmar os relógios.",
      });
    }
    if (!config.order.commandsEnabled) {
      logger.info("system", "Gateway iniciado em modo somente leitura; publicação de pedidos desabilitada", {
        mode: config.mode,
        commandsEnabled: false,
      });
    }
    return server.address();
  }

  async function stop() {
    clearInterval(statePulse);
    clearTimeout(bootstrapTimer);
    orderService.close();
    await mqttClient.end(false).catch((error) => logger.warn("warning", "Falha ao encerrar MQTT", { error }));
    await hub.close().catch(() => {});
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }

  return { config, eventHub: hub, mqttClient, orderService, server, start, stateSnapshot, stop, store };
}

async function main() {
  const gateway = createGateway();
  await gateway.start();
  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`[${new Date().toISOString()}] [SYSTEM] Encerrando por ${signal}`);
    await gateway.stop();
    process.exit(0);
  }
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[${new Date().toISOString()}] [ERROR] [SYSTEM] Gateway não iniciou`, error);
    process.exit(1);
  });
}

module.exports = { createGateway, readJsonBody, resolveStaticFile, sendJson };
