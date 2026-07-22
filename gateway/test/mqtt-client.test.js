"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { FactoryMqttClient } = require("../src/mqtt-client");
const { silentLogger, testConfig } = require("./helpers");

test("cliente MQTT usa 3.1.1 e publica pedido somente em f/o/order QoS 0 não retido", async () => {
  class Transport extends EventEmitter {
    constructor() {
      super();
      this.connected = true;
      this.publications = [];
      this.subscriptions = [];
    }
    subscribe(topic, options, callback) {
      this.subscriptions.push({ topic, options });
      callback(null, [{ topic, qos: options.qos }]);
    }
    publish(topic, payload, options, callback) {
      this.publications.push({ topic, payload, options });
      callback(null);
    }
    end(_force, _options, callback) { callback(); }
  }

  const transport = new Transport();
  let connection = null;
  const client = new FactoryMqttClient(testConfig(), silentLogger(), {
    mqttConnect: (url, options) => {
      connection = { url, options };
      return transport;
    },
  });
  client.connect();
  transport.emit("connect");
  await client.publishOrder('{"type":"WHITE","ts":"2026-07-21T10:00:00.123Z"}');

  assert.equal(connection.url, "mqtt://127.0.0.1:1883");
  assert.equal(connection.options.protocolVersion, 4);
  assert.equal(connection.options.queueQoSZero, false);
  assert.deepEqual(transport.publications[0], {
    topic: "f/o/order",
    payload: '{"type":"WHITE","ts":"2026-07-21T10:00:00.123Z"}',
    options: { qos: 0, retain: false },
  });
  await client.end();
});
