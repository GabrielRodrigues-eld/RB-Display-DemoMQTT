"use strict";

const { EventEmitter } = require("node:events");
const { classifyTopic } = require("./topic-registry");
const { normalizeOrderState, normalizeStationState, normalizeStock } = require("./validators");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

class StateStore extends EventEmitter {
  constructor(config, { clock = Date.now } = {}) {
    super();
    this.config = config;
    this.clock = clock;
    this.startedAt = this.clock();
    this.mqtt = {
      connected: false,
      connecting: false,
      connectionGeneration: 0,
      connectedSinceMs: null,
      reconnectCount: 0,
      connectedAt: null,
      disconnectedAt: null,
      lastError: null,
    };
    this.topics = new Map();
    this.events = [];
    this.eventSequence = 0;
    this.factoryOrder = {
      received: false,
      valid: false,
      state: null,
      type: null,
      sourceTimestamp: null,
      lastSeen: null,
      warnings: [],
      errors: [],
      connectionGeneration: null,
    };
    this.stock = {
      received: false,
      valid: false,
      inconsistent: false,
      counts: { WHITE: 0, RED: 0, BLUE: 0 },
      positions: { WHITE: [], RED: [], BLUE: [] },
      emptyPositions: 0,
      items: [],
      sourceTimestamp: null,
      lastSeen: null,
      warnings: [],
      errors: [],
      rawPayload: null,
      sourceTopic: this.config.mqtt.stockTopic,
      representsPhysicalInspection: false,
      connectionGeneration: null,
    };
    this.stations = new Map();
    this.pendingOrder = null;
    this.lastOrder = null;
  }

  setMqttState(patch) {
    const connected = patch.connected === undefined ? this.mqtt.connected : Boolean(patch.connected);
    const connectionGeneration = !this.mqtt.connected && connected
      ? this.mqtt.connectionGeneration + 1
      : this.mqtt.connectionGeneration;
    const connectedSinceMs = !this.mqtt.connected && connected
      ? this.clock()
      : connected
        ? this.mqtt.connectedSinceMs
        : null;
    this.mqtt = { ...this.mqtt, ...patch, connected, connectionGeneration, connectedSinceMs };
    this.emit("mqtt-state", this.getMqttState());
  }

  getMqttState() {
    return clone(this.mqtt);
  }

  observe(topic, payloadBuffer, packet = {}) {
    const receivedAtMs = this.clock();
    const receivedAt = nowIso(receivedAtMs);
    const raw = Buffer.isBuffer(payloadBuffer) ? payloadBuffer.toString("utf8") : String(payloadBuffer);
    const bytes = Buffer.byteLength(raw, "utf8");
    const previous = this.topics.get(topic) || {
      topic,
      messageCount: 0,
      parseErrorCount: 0,
      schemaErrorCount: 0,
      firstSeen: receivedAt,
    };
    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      parseError = error.message;
    }

    const kind = classifyTopic(this.config, topic);
    let schema = null;
    if (!parseError && kind === "order-state") schema = normalizeOrderState(parsed);
    else if (!parseError && kind === "stock-state") schema = normalizeStock(parsed);
    else if (!parseError && kind === "station-state") schema = normalizeStationState(parsed, topic);

    const retainedOrderState = kind === "order-state" && Boolean(packet.retain);
    const contractWarnings = [];
    if (["order-state", "stock-state", "station-state"].includes(kind) && Number.isInteger(packet.qos) && packet.qos !== 0) {
      contractWarnings.push(`QoS observado ${packet.qos}; esperado QoS 0`);
    }
    const record = {
      ...previous,
      topic,
      kind,
      messageCount: previous.messageCount + 1,
      parseErrorCount: previous.parseErrorCount + (parseError ? 1 : 0),
      schemaErrorCount: previous.schemaErrorCount + (schema && !schema.ok || retainedOrderState ? 1 : 0),
      lastSeen: receivedAt,
      lastSeenMs: receivedAtMs,
      lastPayloadRaw: raw,
      lastPayloadParsed: parsed,
      normalized: schema?.normalized ?? parsed,
      parseError,
      schemaErrors: retainedOrderState ? ["f/i/order retained não é usado para controle"] : schema?.errors || [],
      schemaWarnings: [...(schema?.warnings || []), ...contractWarnings],
      unexpectedFields: schema?.unexpectedFields || [],
      missingFields: schema?.missingFields || [],
      retain: Boolean(packet.retain),
      qos: Number.isInteger(packet.qos) ? packet.qos : null,
      bytes,
    };
    this.topics.set(topic, record);

    if (kind === "order-state") this.updateFactoryOrder(schema, record);
    else if (kind === "stock-state") this.updateStock(schema, record);
    else if (kind === "station-state") this.updateStation(schema, record);

    this.recordEvent({
      topic,
      direction: "inbound",
      kind,
      receivedAt,
      rawPayload: raw,
      parsedPayload: parsed,
      normalizedPayload: schema?.normalized ?? parsed,
      qos: record.qos,
      retain: record.retain,
      bytes,
      warnings: record.schemaWarnings,
      errors: [...(parseError ? [parseError] : []), ...record.schemaErrors],
    });

    const observation = {
      topic,
      kind,
      receivedAt,
      parsed,
      parseError,
      schema,
      record: this.presentTopic(record),
    };
    this.emit("topic-message", observation);
    return observation;
  }

  recordOutbound(topic, rawPayload, metadata = {}) {
    const seenAtMs = this.clock();
    const seenAt = nowIso(seenAtMs);
    const raw = String(rawPayload);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_error) {}
    const previous = this.topics.get(topic) || {
      topic,
      messageCount: 0,
      parseErrorCount: 0,
      schemaErrorCount: 0,
      firstSeen: seenAt,
    };
    const record = {
      ...previous,
      topic,
      kind: "order-command",
      direction: "outbound",
      messageCount: previous.messageCount + 1,
      outboundCount: (previous.outboundCount || 0) + 1,
      lastSeen: seenAt,
      lastSeenMs: seenAtMs,
      lastPayloadRaw: raw,
      lastPayloadParsed: parsed,
      normalized: parsed,
      parseError: null,
      schemaErrors: [],
      schemaWarnings: [],
      unexpectedFields: [],
      missingFields: [],
      retain: Boolean(metadata.retain),
      qos: Number.isInteger(metadata.qos) ? metadata.qos : null,
      bytes: Buffer.byteLength(raw, "utf8"),
    };
    this.topics.set(topic, record);
    this.recordEvent({
      topic,
      direction: "outbound",
      kind: record.kind,
      receivedAt: seenAt,
      rawPayload: raw,
      parsedPayload: parsed,
      normalizedPayload: parsed,
      qos: record.qos,
      retain: record.retain,
      bytes: record.bytes,
      warnings: [],
      errors: [],
    });
    const observation = { topic, kind: record.kind, receivedAt: seenAt, parsed, parseError: null, schema: null, record: this.presentTopic(record) };
    this.emit("topic-message", observation);
    return observation;
  }

  updateFactoryOrder(schema, record) {
    if (schema?.ok && !record.retain) {
      this.factoryOrder = {
        received: true,
        valid: true,
        state: schema.normalized.state,
        type: schema.normalized.type,
        sourceTimestamp: schema.normalized.ts,
        lastSeen: record.lastSeen,
        lastSeenMs: record.lastSeenMs,
        warnings: schema.warnings,
        errors: [],
        connectionGeneration: this.mqtt.connectionGeneration,
      };
    } else {
      this.factoryOrder = {
        ...this.factoryOrder,
        received: true,
        valid: false,
        lastSeen: record.lastSeen,
        lastSeenMs: record.lastSeenMs,
        warnings: schema?.warnings || [],
        connectionGeneration: this.mqtt.connectionGeneration,
        errors: record.retain
          ? ["f/i/order retained foi preservado para diagnóstico e não usado como estado de controle"]
          : schema?.errors || [record.parseError || "payload inválido"],
      };
    }
    this.emit("factory-order-state", this.getFactoryOrder());
  }

  updateStock(schema, record) {
    const normalized = schema?.normalized;
    this.stock = {
      received: true,
      valid: Boolean(schema?.ok && normalized?.complete),
      inconsistent: !schema?.ok || Boolean(normalized?.inconsistent),
      counts: normalized?.counts || { WHITE: 0, RED: 0, BLUE: 0 },
      positions: normalized?.positions || { WHITE: [], RED: [], BLUE: [] },
      emptyPositions: normalized?.emptyPositions || 0,
      items: normalized?.items || [],
      sourceTimestamp: normalized?.ts || null,
      lastSeen: record.lastSeen,
      lastSeenMs: record.lastSeenMs,
      warnings: schema?.warnings || [],
      errors: schema?.errors || [record.parseError || "payload inválido"],
      rawPayload: record.lastPayloadRaw,
      sourceTopic: record.topic,
      representsPhysicalInspection: false,
      connectionGeneration: this.mqtt.connectionGeneration,
    };
    this.emit("stock-state", this.getStock());
  }

  updateStation(schema, record) {
    if (!schema?.ok) return;
    const station = {
      ...schema.normalized,
      lastSeen: record.lastSeen,
      lastSeenMs: record.lastSeenMs,
      warnings: schema.warnings,
      connectionGeneration: this.mqtt.connectionGeneration,
    };
    this.stations.set(station.station, station);
    this.emit("station-state", this.presentStation(station));
  }

  recordEvent(event) {
    if (event.kind === "camera" || this.config.observability.topicHistoryLimit < 1) return;
    this.events.push({ sequence: ++this.eventSequence, ...clone(event) });
    const overflow = this.events.length - this.config.observability.topicHistoryLimit;
    if (overflow > 0) this.events.splice(0, overflow);
  }

  isStale(lastSeenMs, thresholdMs) {
    return !lastSeenMs || this.clock() - lastSeenMs > thresholdMs;
  }

  getFactoryOrder() {
    const observedOnCurrentConnection = this.factoryOrder.connectionGeneration !== null
      && this.factoryOrder.connectionGeneration === this.mqtt.connectionGeneration;
    const bootstrap = this.getFactoryBootstrapStatus({ observedOnCurrentConnection });
    if (bootstrap.ready) {
      return {
        received: true,
        valid: true,
        state: "WAITING_FOR_ORDER",
        type: null,
        sourceTimestamp: null,
        lastSeen: bootstrap.evidenceLastSeen,
        warnings: ["WAITING_FOR_ORDER inferido no bootstrap a partir de estoque e seis estações READY"],
        errors: [],
        connectionGeneration: this.mqtt.connectionGeneration,
        stale: false,
        freshnessPolicy: "station-bootstrap",
        inferred: true,
        inference: bootstrap,
      };
    }
    return {
      ...clone(this.factoryOrder),
      stale: !this.mqtt.connected || !observedOnCurrentConnection,
      freshnessPolicy: "connection-scoped-event",
      inferred: false,
      inference: bootstrap,
    };
  }

  getFactoryBootstrapStatus({ observedOnCurrentConnection } = {}) {
    const observedCurrent = observedOnCurrentConnection ?? (
      this.factoryOrder.connectionGeneration !== null
      && this.factoryOrder.connectionGeneration === this.mqtt.connectionGeneration
    );
    const requiredStations = this.config.factory.requiredReadyStations;
    const missingStations = [];
    const staleStations = [];
    const notReadyStations = [];
    const evidenceTimes = [];

    for (const stationName of requiredStations) {
      const station = this.stations.get(stationName);
      if (!station || station.connectionGeneration !== this.mqtt.connectionGeneration) {
        missingStations.push(stationName);
        continue;
      }
      if (this.isStale(station.lastSeenMs, this.config.timing.topicStaleAfterMs)) staleStations.push(stationName);
      if (station.code !== 1 || station.state !== "READY") notReadyStations.push(stationName);
      if (station.lastSeen) evidenceTimes.push(station.lastSeen);
    }

    const stockCurrent = this.stock.received
      && this.stock.connectionGeneration === this.mqtt.connectionGeneration;
    const stockFresh = stockCurrent
      && !this.isStale(this.stock.lastSeenMs, this.config.timing.stockStaleAfterMs);
    const stockReady = stockFresh && this.stock.valid && !this.stock.inconsistent;
    if (this.stock.lastSeen) evidenceTimes.push(this.stock.lastSeen);
    const connectedElapsedMs = this.mqtt.connected && this.mqtt.connectedSinceMs !== null
      ? Math.max(0, this.clock() - this.mqtt.connectedSinceMs)
      : 0;
    const graceElapsed = connectedElapsedMs >= this.config.factory.bootstrapGraceMs;
    const ready = this.config.factory.inferWaitingOnBoot
      && this.mqtt.connected
      && !observedCurrent
      && !this.pendingOrder
      && graceElapsed
      && stockReady
      && missingStations.length === 0
      && staleStations.length === 0
      && notReadyStations.length === 0;

    return {
      enabled: this.config.factory.inferWaitingOnBoot,
      ready,
      graceElapsed,
      connectedElapsedMs,
      graceMs: this.config.factory.bootstrapGraceMs,
      evidenceLastSeen: evidenceTimes.sort().at(-1) || null,
      stockReady,
      missingStations,
      staleStations,
      notReadyStations,
      requiredStations: [...requiredStations],
      blockedByOrderEvent: observedCurrent,
      blockedByPendingOrder: Boolean(this.pendingOrder),
    };
  }

  getStock({ includeRaw = this.config.mqtt.enableRawDiagnostics } = {}) {
    const value = clone(this.stock);
    value.stale = this.isStale(this.stock.lastSeenMs, this.config.timing.stockStaleAfterMs);
    if (!includeRaw) delete value.rawPayload;
    delete value.lastSeenMs;
    return value;
  }

  presentStation(station) {
    const value = clone(station);
    value.stale = this.isStale(station.lastSeenMs, this.config.timing.topicStaleAfterMs);
    delete value.lastSeenMs;
    return value;
  }

  getStations() {
    return Object.fromEntries([...this.stations.entries()].map(([name, station]) => [name, this.presentStation(station)]));
  }

  setPendingOrder(order) {
    this.pendingOrder = clone(order);
    this.emit("order-state", this.getOrderState());
  }

  transitionPendingOrder(status, detail = {}) {
    if (!this.pendingOrder) return null;
    const at = nowIso(this.clock());
    this.pendingOrder.status = status;
    this.pendingOrder.updatedAt = at;
    Object.assign(this.pendingOrder, detail);
    const previousAt = this.pendingOrder.transitions.at(-1)?.at;
    const deltaMs = previousAt ? Math.max(0, Date.parse(at) - Date.parse(previousAt)) : null;
    this.pendingOrder.transitions.push({ status, at, deltaMs, factoryState: detail.factoryState || this.factoryOrder.state || null });
    this.emit("order-state", this.getOrderState());
    return clone(this.pendingOrder);
  }

  completePendingOrder(reason = "factory-ready", detail = {}) {
    if (!this.pendingOrder) return null;
    const completed = {
      ...this.pendingOrder,
      status: "idle",
      completionReason: reason,
      completedAt: nowIso(this.clock()),
      ...detail,
    };
    completed.transitions.push({ status: "idle", at: completed.completedAt, factoryState: this.factoryOrder.state });
    this.lastOrder = clone(completed);
    this.pendingOrder = null;
    this.emit("order-state", this.getOrderState());
    return completed;
  }

  getOrderState() {
    return {
      status: this.pendingOrder?.status || "idle",
      pending: clone(this.pendingOrder),
      last: clone(this.lastOrder),
      factory: this.getFactoryOrder(),
    };
  }

  presentTopic(record) {
    const value = clone(record);
    value.stale = this.isStale(record.lastSeenMs, this.config.timing.topicStaleAfterMs);
    delete value.lastSeenMs;
    if (!this.config.mqtt.enableRawDiagnostics) value.lastPayloadRaw = null;
    return value;
  }

  getTopics() {
    return [...this.topics.values()]
      .map((record) => this.presentTopic(record))
      .sort((a, b) => a.topic.localeCompare(b.topic));
  }

  getEvents({ limit = this.config.observability.topicHistoryLimit } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || this.config.observability.topicHistoryLimit, this.config.observability.topicHistoryLimit));
    return this.events.slice(-safeLimit).map((event) => {
      const value = clone(event);
      if (!this.config.mqtt.enableRawDiagnostics) value.rawPayload = null;
      return value;
    });
  }

  getState() {
    return {
      mode: this.config.mode,
      mqtt: this.getMqttState(),
      order: this.getOrderState(),
      stock: this.getStock(),
      stations: this.getStations(),
      diagnostics: {
        startedAt: nowIso(this.startedAt),
        topicCount: this.topics.size,
        messageCount: [...this.topics.values()].reduce((sum, topic) => sum + topic.messageCount, 0),
        parseErrorCount: [...this.topics.values()].reduce((sum, topic) => sum + topic.parseErrorCount, 0),
        schemaErrorCount: [...this.topics.values()].reduce((sum, topic) => sum + topic.schemaErrorCount, 0),
        eventHistoryCount: this.events.length,
        eventHistoryLimit: this.config.observability.topicHistoryLimit,
      },
    };
  }
}

module.exports = { StateStore };
