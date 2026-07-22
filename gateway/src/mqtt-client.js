"use strict";

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const mqtt = require("mqtt");
const { redactMqttUrl } = require("./config");
const { createSubscriptions } = require("./topic-registry");

class FactoryMqttClient extends EventEmitter {
  constructor(config, logger, { mqttConnect = mqtt.connect } = {}) {
    super();
    this.config = config;
    this.logger = logger;
    this.mqttConnect = mqttConnect;
    this.client = null;
    this.connected = false;
    this.connecting = false;
    this.reconnectCount = 0;
    this.lastError = null;
    this.clientId = `${config.mqtt.clientIdPrefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }

  connect() {
    if (this.client) return this.client;
    this.connecting = true;
    const options = {
      protocolVersion: this.config.mqtt.protocolVersion,
      clientId: this.clientId,
      clean: true,
      keepalive: this.config.mqtt.keepaliveSeconds,
      reconnectPeriod: this.config.mqtt.reconnectPeriodMs,
      connectTimeout: 8000,
      queueQoSZero: false,
      resubscribe: false,
    };
    if (this.config.mqtt.username) options.username = this.config.mqtt.username;
    if (this.config.mqtt.password) options.password = this.config.mqtt.password;

    this.logger.info("confirmed", "Conectando gateway ao broker MQTT TCP", {
      url: redactMqttUrl(this.config.mqtt.url),
      protocolVersion: options.protocolVersion,
      clientId: this.clientId,
    });
    this.client = this.mqttConnect(this.config.mqtt.url, options);
    this.bindEvents(this.client);
    this.emitState();
    return this.client;
  }

  bindEvents(client) {
    client.on("connect", () => {
      this.connected = true;
      this.connecting = false;
      this.lastError = null;
      this.logger.info("observed", "MQTT conectado", { clientId: this.clientId });
      this.subscribeAll();
      this.emitState({ connectedAt: new Date().toISOString() });
    });
    client.on("reconnect", () => {
      this.connected = false;
      this.connecting = true;
      this.reconnectCount += 1;
      this.logger.warn("observed", "MQTT reconectando", { reconnectCount: this.reconnectCount });
      this.emitState();
    });
    client.on("offline", () => {
      this.connected = false;
      this.connecting = false;
      this.emitState({ disconnectedAt: new Date().toISOString() });
    });
    client.on("close", () => {
      this.connected = false;
      this.connecting = false;
      this.emitState({ disconnectedAt: new Date().toISOString() });
    });
    client.on("error", (error) => {
      this.lastError = { message: error.message, code: error.code || null, at: new Date().toISOString() };
      this.logger.error("warning", "Erro MQTT", this.lastError);
      this.emitState();
    });
    client.on("message", (topic, payload, packet) => {
      this.emit("message", topic, payload, packet);
    });
  }

  subscribeAll() {
    for (const subscription of createSubscriptions(this.config)) {
      this.client.subscribe(subscription.topic, { qos: subscription.qos }, (error, granted) => {
        if (error) {
          this.logger.error("warning", "Falha ao assinar tópico", { topic: subscription.topic, error });
          this.emit("subscription-error", { topic: subscription.topic, error });
          return;
        }
        this.logger.info("confirmed", "Assinatura MQTT ativa", { topic: subscription.topic, granted });
      });
    }
  }

  publishOrder(payload) {
    return new Promise((resolve, reject) => {
      if (!this.client?.connected || !this.connected) {
        const error = new Error("Gateway MQTT offline; pedido não publicado.");
        error.code = "MQTT_OFFLINE";
        reject(error);
        return;
      }
      this.client.publish(this.config.mqtt.orderTopic, payload, { qos: 0, retain: false }, (error) => {
        if (error) {
          error.code = error.code || "PUBLISH_FAILED";
          reject(error);
          return;
        }
        this.logger.info("confirmed", "Pedido publicado uma única vez", {
          topic: this.config.mqtt.orderTopic,
          qos: 0,
          retain: false,
          payload,
        });
        this.emit("order-published", { topic: this.config.mqtt.orderTopic, qos: 0, retain: false, payload });
        resolve({ topic: this.config.mqtt.orderTopic, qos: 0, retain: false });
      });
    });
  }

  emitState(extra = {}) {
    const state = {
      connected: Boolean(this.client?.connected && this.connected),
      connecting: this.connecting,
      reconnectCount: this.reconnectCount,
      clientId: this.clientId,
      brokerUrl: redactMqttUrl(this.config.mqtt.url),
      lastError: this.lastError,
      ...extra,
    };
    this.emit("state", state);
    return state;
  }

  getState() {
    return this.emitState();
  }

  async end(force = false) {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.connected = false;
    this.connecting = false;
    await new Promise((resolve) => client.end(force, {}, resolve));
  }
}

module.exports = { FactoryMqttClient };
