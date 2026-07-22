"use strict";

const ENVIRONMENT_TOPICS = Object.freeze([
  "i/broadcast",
  "i/bme680",
  "i/ldr",
  "i/alert",
  "i/ptu/pos",
  "f/i/nfc/ds",
  "f/i/alert",
]);

function unique(values) {
  return [...new Set(values)];
}

function createSubscriptions(config) {
  const topics = [config.mqtt.orderStateTopic, config.mqtt.stockTopic, config.mqtt.stationStateTopic];
  if (config.mqtt.enableEnvironmentTopics) topics.push(...ENVIRONMENT_TOPICS);
  if (config.mqtt.enableCameraTopic) topics.push("i/cam");
  topics.push(...config.mqtt.extraSubscriptions);
  return unique(topics).map((topic) => ({ topic, qos: 0 }));
}

function classifyTopic(config, topic) {
  if (topic === config.mqtt.orderStateTopic) return "order-state";
  if (topic === config.mqtt.stockTopic) return "stock-state";
  if (/^f\/i\/state\/[^/]+$/.test(topic)) return "station-state";
  if (topic === "i/cam") return "camera";
  if (ENVIRONMENT_TOPICS.includes(topic)) return "environment";
  return "diagnostic";
}

module.exports = { ENVIRONMENT_TOPICS, classifyTopic, createSubscriptions };
