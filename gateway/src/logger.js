"use strict";

const LABELS = Object.freeze({
  confirmed: "CONFIRMED CONTRACT",
  observed: "OBSERVED IN RUNTIME",
  unknown: "UNKNOWN PAYLOAD",
  warning: "INTEGRATION WARNING",
  simulation: "SIMULATION EVENT",
  system: "SYSTEM",
});

function serialize(value) {
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
  return value;
}

function createLogger({ sink = console } = {}) {
  function write(level, category, message, data) {
    const label = LABELS[category] || String(category || "SYSTEM").toUpperCase();
    const prefix = `[${new Date().toISOString()}] [${level}] [${label}] ${message}`;
    const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
    if (data === undefined) sink[method](prefix);
    else sink[method](prefix, JSON.stringify(data, (_key, value) => serialize(value)));
  }

  return Object.freeze({
    info: (category, message, data) => write("INFO", category, message, data),
    warn: (category, message, data) => write("WARN", category, message, data),
    error: (category, message, data) => write("ERROR", category, message, data),
  });
}

module.exports = { LABELS, createLogger };
