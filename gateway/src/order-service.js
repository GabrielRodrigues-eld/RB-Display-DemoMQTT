"use strict";

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { validateOrderRequest } = require("./validators");

class OrderError extends Error {
  constructor(code, message, details = {}, statusCode = 409) {
    super(message);
    this.name = "OrderError";
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

class OrderService extends EventEmitter {
  constructor(config, store, mqttClient, logger, { clock = () => new Date() } = {}) {
    super();
    this.config = config;
    this.store = store;
    this.mqttClient = mqttClient;
    this.logger = logger;
    this.clock = clock;
    this.acceptanceTimer = null;
  }

  validatePreconditions(input) {
    const validated = validateOrderRequest(input);
    if (!validated.ok) throw new OrderError(validated.code, validated.message, {}, 400);
    const type = validated.value.type;
    if (!this.config.order.commandsEnabled) {
      throw new OrderError(
        "FACTORY_COMMANDS_DISABLED",
        "Comandos físicos estão desabilitados neste gateway.",
        { mode: this.config.mode },
        403,
      );
    }
    if (!this.store.mqtt.connected) throw new OrderError("MQTT_OFFLINE", "O gateway não está conectado ao broker MQTT.");
    if (this.store.pendingOrder) throw new OrderError("ORDER_ALREADY_PENDING", "Já existe um pedido local pendente.", { pending: this.store.getOrderState().pending });

    const factory = this.store.getFactoryOrder();
    if (!factory.received || !factory.valid || factory.stale || factory.state !== "WAITING_FOR_ORDER") {
      throw new OrderError("FACTORY_NOT_READY", "A fábrica ainda não confirmou WAITING_FOR_ORDER.", { factory });
    }

    const stock = this.store.getStock();
    if (!stock.received) throw new OrderError("STOCK_UNKNOWN", "O gateway ainda não recebeu o estoque.");
    if (stock.stale) throw new OrderError("STOCK_STALE", "O estoque está desatualizado.", { lastSeen: stock.lastSeen });
    if (!stock.valid || stock.inconsistent) {
      throw new OrderError("STOCK_INVALID", "O snapshot de estoque está inconsistente.", { warnings: stock.warnings, errors: stock.errors });
    }
    if ((stock.counts[type] || 0) < 1) throw new OrderError("OUT_OF_STOCK", `Não há peças ${type} disponíveis.`, { counts: stock.counts });
    return type;
  }

  async requestOrder(input, audit = {}) {
    const type = this.validatePreconditions(input);
    const now = this.clock();
    const generatedAtUtc = now.toISOString();
    const timestampOffsetMinutes = this.config.order.timestampOffsetMinutes;
    const timestamp = new Date(now.getTime() + timestampOffsetMinutes * 60 * 1000).toISOString();
    const localId = randomUUID();
    const payload = { type, ts: timestamp };
    const pending = {
      localId,
      type,
      status: "submitting",
      createdAt: generatedAtUtc,
      updatedAt: generatedAtUtc,
      publishedAt: null,
      payload,
      publish: { topic: this.config.mqtt.orderTopic, qos: 0, retain: false, attempts: 1 },
      audit: { remoteAddress: audit.remoteAddress || null, userAgent: audit.userAgent || null },
      timestampPolicy: {
        generatedAtUtc,
        offsetMinutes: timestampOffsetMinutes,
      },
      seenOrdered: false,
      seenInProcess: false,
      seenShipped: false,
      completedWithoutShipped: false,
      uncertainReason: null,
      transitions: [{ status: "submitting", at: generatedAtUtc, factoryState: this.store.factoryOrder.state }],
    };
    this.store.setPendingOrder(pending);

    try {
      await this.mqttClient.publishOrder(JSON.stringify(payload));
      if (this.store.pendingOrder?.localId === localId) {
        const publishedAt = this.clock().toISOString();
        if (this.store.pendingOrder.status === "submitting") {
          this.store.transitionPendingOrder("awaiting_ordered", { publishedAt });
        } else {
          this.store.pendingOrder.publishedAt = publishedAt;
        }
        this.startAcceptanceTimer(localId);
      }
      return { ok: true, order: this.store.getOrderState().pending };
    } catch (error) {
      this.logger.error("warning", "Falha ao publicar pedido; não haverá reenvio", { localId, type, error });
      if (this.store.pendingOrder?.localId === localId) {
        this.store.transitionPendingOrder("error", { uncertainReason: "PUBLISH_FAILED", error: error.message });
      }
      throw new OrderError(error.code === "MQTT_OFFLINE" ? "MQTT_OFFLINE" : "PUBLISH_FAILED", "Não foi possível publicar o pedido. Nenhum reenvio foi realizado.", { localId });
    }
  }

  startAcceptanceTimer(localId) {
    clearTimeout(this.acceptanceTimer);
    this.acceptanceTimer = setTimeout(() => {
      const pending = this.store.pendingOrder;
      if (!pending || pending.localId !== localId || pending.status !== "awaiting_ordered") return;
      this.store.transitionPendingOrder("uncertain", {
        uncertainReason: "ORDERED_TIMEOUT",
        error: "ORDERED não chegou dentro do tempo configurado. O pedido não foi reenviado.",
      });
      this.logger.warn("warning", "Timeout aguardando ORDERED; pedido mantido para reconciliação", { localId, type: pending.type });
      this.emit("integration-warning", { code: "ORDERED_TIMEOUT", order: this.store.getOrderState().pending });
    }, this.config.timing.orderAcceptanceTimeoutMs);
    this.acceptanceTimer.unref?.();
  }

  handleFactoryState(factory) {
    const pending = this.store.pendingOrder;
    if (!pending || !factory.valid) return;
    const state = factory.state;

    if (state === "WAITING_FOR_ORDER") {
      if (pending.seenOrdered || pending.seenInProcess || pending.seenShipped) {
        clearTimeout(this.acceptanceTimer);
        const completedWithoutShipped = !pending.seenShipped;
        const completed = this.store.completePendingOrder("returned-to-waiting", { completedWithoutShipped });
        this.logger.info("observed", "Ciclo do pedido concluído e novo pedido liberado", {
          localId: completed.localId,
          type: completed.type,
          completedWithoutShipped,
        });
      }
      return;
    }

    if (factory.type !== pending.type) {
      this.logger.warn("warning", "Estado de pedido ignorado por divergência de cor", { expected: pending.type, observed: factory.type, state });
      this.emit("integration-warning", { code: "ORDER_TYPE_MISMATCH", expected: pending.type, observed: factory });
      return;
    }

    const statusForFactoryState = {
      ORDERED: "ordered",
      IN_PROCESS: "in_process",
      SHIPPED: "awaiting_ready",
    };
    const alreadyObserved = state === "ORDERED"
      ? pending.seenOrdered
      : state === "IN_PROCESS"
        ? pending.seenInProcess
        : state === "SHIPPED" && pending.seenShipped;
    if (statusForFactoryState[state] === pending.status || alreadyObserved) {
      this.logger.warn("observed", "Estado de pedido duplicado observado", { localId: pending.localId, state, type: factory.type });
      return;
    }
    const expectedNext = {
      submitting: "ORDERED",
      awaiting_ordered: "ORDERED",
      uncertain: "ORDERED",
      ordered: "IN_PROCESS",
      in_process: "SHIPPED",
    }[pending.status];
    if (expectedNext && state !== expectedNext) {
      this.logger.warn("warning", "Transição de pedido fora da ordem esperada; estado será usado para reconciliação", {
        localId: pending.localId,
        localStatus: pending.status,
        expectedNext,
        observed: state,
      });
      this.emit("integration-warning", { code: "ORDER_STATE_OUT_OF_SEQUENCE", expectedNext, observed: factory });
    }

    clearTimeout(this.acceptanceTimer);
    if (state === "ORDERED") this.store.transitionPendingOrder("ordered", { factoryState: state, seenOrdered: true, uncertainReason: null, error: null });
    else if (state === "IN_PROCESS") this.store.transitionPendingOrder("in_process", { factoryState: state, seenInProcess: true, uncertainReason: null, error: null });
    else if (state === "SHIPPED") {
      this.store.transitionPendingOrder("shipped", { factoryState: state, seenShipped: true, uncertainReason: null, error: null });
      this.store.transitionPendingOrder("awaiting_ready", { factoryState: state, seenShipped: true });
    }
  }

  close() {
    clearTimeout(this.acceptanceTimer);
  }
}

module.exports = { OrderError, OrderService };
