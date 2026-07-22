"use strict";

const VALID_TYPES = Object.freeze(["WHITE", "RED", "BLUE"]);
const ORDER_STATES = Object.freeze(["WAITING_FOR_ORDER", "ORDERED", "IN_PROCESS", "SHIPPED"]);
const LOCATIONS = Object.freeze(["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"]);
const WORKPIECE_TYPES = Object.freeze(["NONE", ...VALID_TYPES]);
const WORKPIECE_STATES = Object.freeze(["NONE", "RAW", "PROCESSED", "REJECTED"]);
const STATION_CODES = Object.freeze({
  0: "OFF",
  1: "READY",
  2: "BUSY",
  3: "WAIT_READY",
  4: "ERROR",
  6: "WAIT_ERROR",
  7: "CALIBRATION",
});
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIsoUtc(value) {
  return typeof value === "string" && ISO_UTC_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function inspectFields(value, expected, required = expected) {
  const keys = isPlainObject(value) ? Object.keys(value) : [];
  return {
    unexpectedFields: keys.filter((key) => !expected.includes(key)),
    missingFields: required.filter((key) => !keys.includes(key)),
  };
}

function validateOrderRequest(value) {
  if (!isPlainObject(value)) return { ok: false, code: "INVALID_TYPE", message: "O corpo deve ser um objeto JSON." };
  if (!VALID_TYPES.includes(value.type)) {
    return { ok: false, code: "INVALID_TYPE", message: "type deve ser exatamente WHITE, RED ou BLUE." };
  }
  return { ok: true, value: { type: value.type } };
}

function normalizeOrderState(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["payload deve ser um objeto"], warnings, normalized: null, unexpectedFields: [], missingFields: ["ts", "state", "type"] };
  }
  const fields = inspectFields(value, ["ts", "state", "type"]);
  if (fields.missingFields.length) errors.push(`campos ausentes: ${fields.missingFields.join(", ")}`);
  if (fields.unexpectedFields.length) warnings.push(`campos inesperados: ${fields.unexpectedFields.join(", ")}`);
  if (!isIsoUtc(value.ts)) errors.push("ts não é ISO 8601 UTC com milissegundos");
  if (!ORDER_STATES.includes(value.state)) errors.push(`state desconhecido: ${String(value.state)}`);
  if (value.state === "WAITING_FOR_ORDER") {
    if (!(value.type === "" || value.type === null || value.type === undefined || VALID_TYPES.includes(value.type))) {
      errors.push("type inválido em WAITING_FOR_ORDER");
    }
  } else if (!VALID_TYPES.includes(value.type)) {
    errors.push("type não é WHITE, RED ou BLUE");
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    unexpectedFields: fields.unexpectedFields,
    missingFields: fields.missingFields,
    normalized: errors.length ? null : { ts: value.ts, state: value.state, type: value.type || null },
  };
}

function normalizeStock(value) {
  const errors = [];
  const warnings = [];
  const empty = { WHITE: 0, RED: 0, BLUE: 0 };
  const positions = { WHITE: [], RED: [], BLUE: [] };
  const fields = inspectFields(value, ["ts", "stockItems"]);

  if (!isPlainObject(value)) {
    return { ok: false, errors: ["payload deve ser um objeto"], warnings, normalized: null, unexpectedFields: [], missingFields: ["ts", "stockItems"] };
  }
  if (fields.missingFields.length) errors.push(`campos ausentes: ${fields.missingFields.join(", ")}`);
  if (fields.unexpectedFields.length) warnings.push(`campos inesperados: ${fields.unexpectedFields.join(", ")}`);
  if (!isIsoUtc(value.ts)) errors.push("ts não é ISO 8601 UTC com milissegundos");
  if (!Array.isArray(value.stockItems)) errors.push("stockItems deve ser um array");

  const items = [];
  const seen = new Set();
  let emptyPositions = 0;
  for (const [index, item] of (Array.isArray(value.stockItems) ? value.stockItems : []).entries()) {
    if (!isPlainObject(item)) {
      errors.push(`stockItems[${index}] deve ser objeto`);
      continue;
    }
    if (!LOCATIONS.includes(item.location)) errors.push(`localização inválida em stockItems[${index}]`);
    if (seen.has(item.location)) errors.push(`localização duplicada: ${item.location}`);
    seen.add(item.location);
    const itemFields = inspectFields(item, ["location", "workpiece"]);
    if (itemFields.missingFields.length) errors.push(`campos ausentes em ${item.location || index}: ${itemFields.missingFields.join(", ")}`);
    if (itemFields.unexpectedFields.length) warnings.push(`campos inesperados em ${item.location || index}: ${itemFields.unexpectedFields.join(", ")}`);

    if (item.workpiece === null) {
      emptyPositions += 1;
      items.push({ location: item.location, workpiece: null });
      continue;
    }
    if (!isPlainObject(item.workpiece)) {
      errors.push(`workpiece inválida em ${item.location || index}`);
      continue;
    }
    const pieceFields = inspectFields(item.workpiece, ["id", "type", "state"], ["type", "state"]);
    if (pieceFields.missingFields.length) errors.push(`campos de peça ausentes em ${item.location}: ${pieceFields.missingFields.join(", ")}`);
    if (pieceFields.unexpectedFields.length) warnings.push(`campos de peça inesperados em ${item.location}: ${pieceFields.unexpectedFields.join(", ")}`);
    const physicalEmpty = String(item.workpiece.id) === "0"
      && item.workpiece.type === ""
      && item.workpiece.state === "";
    if (physicalEmpty) {
      emptyPositions += 1;
      items.push({ location: item.location, workpiece: null });
      continue;
    }
    if (!WORKPIECE_TYPES.includes(item.workpiece.type)) errors.push(`tipo de peça inválido em ${item.location}`);
    if (!WORKPIECE_STATES.includes(item.workpiece.state)) errors.push(`estado de peça inválido em ${item.location}`);
    if (VALID_TYPES.includes(item.workpiece.type)) {
      empty[item.workpiece.type] += 1;
      positions[item.workpiece.type].push(item.location);
    } else if (item.workpiece.type === "NONE") {
      emptyPositions += 1;
    }
    items.push({
      location: item.location,
      workpiece: {
        id: item.workpiece.id === undefined ? null : String(item.workpiece.id),
        type: item.workpiece.type,
        state: item.workpiece.state,
      },
    });
  }

  const missingLocations = LOCATIONS.filter((location) => !seen.has(location));
  if (missingLocations.length) warnings.push(`posições não informadas: ${missingLocations.join(", ")}`);
  const complete = errors.length === 0 && missingLocations.length === 0 && seen.size === LOCATIONS.length;
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    unexpectedFields: fields.unexpectedFields,
    missingFields: fields.missingFields,
    normalized: {
      ts: value.ts,
      items,
      counts: empty,
      positions,
      emptyPositions,
      complete,
      inconsistent: errors.length > 0 || warnings.length > 0,
    },
  };
}

function normalizeStationState(value, topic) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["payload deve ser um objeto"], warnings, normalized: null, unexpectedFields: [], missingFields: ["ts", "station", "code", "description", "active"] };
  }
  const fields = inspectFields(value, ["ts", "station", "code", "description", "active", "target"], ["ts", "station", "code", "description", "active"]);
  if (fields.missingFields.length) errors.push(`campos ausentes: ${fields.missingFields.join(", ")}`);
  if (fields.unexpectedFields.length) warnings.push(`campos inesperados: ${fields.unexpectedFields.join(", ")}`);
  if (!isIsoUtc(value.ts)) errors.push("ts inválido");
  if (typeof value.station !== "string" || !value.station) errors.push("station inválida");
  const code = Number(value.code);
  if (!Number.isInteger(code) || !Object.prototype.hasOwnProperty.call(STATION_CODES, code)) errors.push(`code desconhecido: ${String(value.code)}`);
  if (typeof value.description !== "string") errors.push("description deve ser string");
  const activeIsValid = typeof value.active === "boolean" || value.active === 0 || value.active === 1;
  if (!activeIsValid) errors.push("active deve ser boolean ou 0/1");
  const topicStation = String(topic).split("/").pop();
  if (value.station && topicStation !== "+" && value.station.toLowerCase() !== topicStation.toLowerCase()) {
    warnings.push(`station ${value.station} diverge do tópico ${topicStation}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    unexpectedFields: fields.unexpectedFields,
    missingFields: fields.missingFields,
    normalized: errors.length ? null : {
      ts: value.ts,
      station: value.station.toLowerCase(),
      code,
      state: STATION_CODES[code],
      description: String(value.description),
      active: value.active === true || value.active === 1,
      target: value.target === undefined ? null : String(value.target),
      raw: { ...value },
    },
  };
}

module.exports = {
  ISO_UTC_PATTERN,
  LOCATIONS,
  ORDER_STATES,
  STATION_CODES,
  VALID_TYPES,
  WORKPIECE_STATES,
  WORKPIECE_TYPES,
  isIsoUtc,
  isPlainObject,
  normalizeOrderState,
  normalizeStationState,
  normalizeStock,
  validateOrderRequest,
};
