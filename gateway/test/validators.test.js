"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeOrderState,
  normalizeStationState,
  normalizeStock,
  validateOrderRequest,
} = require("../src/validators");
const { orderState, physicalStockPayload, stockPayload } = require("./helpers");

test("aceita somente WHITE, RED e BLUE no pedido HTTP", () => {
  for (const type of ["WHITE", "RED", "BLUE"]) assert.equal(validateOrderRequest({ type }).ok, true);
  for (const type of ["white", "GREEN", "", null, 1]) assert.equal(validateOrderRequest({ type }).ok, false);
});

test("normaliza os quatro estados oficiais de f/i/order", () => {
  for (const state of ["WAITING_FOR_ORDER", "ORDERED", "IN_PROCESS", "SHIPPED"]) {
    const type = state === "WAITING_FOR_ORDER" ? "" : "WHITE";
    const result = normalizeOrderState(orderState(state, type));
    assert.equal(result.ok, true);
    assert.equal(result.normalized.state, state);
  }
});

test("estado desconhecido permanece inválido e diagnosticável", () => {
  const result = normalizeOrderState(orderState("MAINTENANCE", "WHITE"));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /desconhecido/);
});

test("normaliza estoque completo, conta cores, vazios e posições", () => {
  const result = normalizeStock(stockPayload({ WHITE: 2, RED: 1, BLUE: 3 }));
  assert.equal(result.ok, true);
  assert.equal(result.normalized.complete, true);
  assert.deepEqual(result.normalized.counts, { WHITE: 2, RED: 1, BLUE: 3 });
  assert.equal(result.normalized.emptyPositions, 3);
  assert.deepEqual(result.normalized.positions.WHITE, ["A1", "A2"]);
  assert.deepEqual(result.normalized.positions.RED, ["A3"]);
  assert.deepEqual(result.normalized.positions.BLUE, ["B1", "B2", "B3"]);
});

test("normaliza como vazio tanto workpiece null quanto o formato observado na fábrica", () => {
  const nullEmpty = normalizeStock(stockPayload({ WHITE: 1, RED: 1, BLUE: 1 }));
  assert.equal(nullEmpty.ok, true);
  assert.equal(nullEmpty.normalized.emptyPositions, 6);

  const physical = normalizeStock(physicalStockPayload());
  assert.equal(physical.ok, true);
  assert.equal(physical.normalized.complete, true);
  assert.equal(physical.normalized.inconsistent, false);
  assert.deepEqual(physical.normalized.counts, { WHITE: 2, RED: 3, BLUE: 1 });
  assert.equal(physical.normalized.emptyPositions, 3);
  assert.deepEqual(
    physical.normalized.items.filter((item) => item.workpiece === null).map((item) => item.location),
    ["A1", "C1", "C2"],
  );
});

test("estoque malformado não lança exceção", () => {
  const result = normalizeStock({ ts: "inválido", stockItems: [{ location: "Z9", workpiece: "x" }] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2);
});

test("normaliza códigos conhecidos de estação e rejeita código desconhecido", () => {
  const ready = normalizeStationState({
    ts: "2026-07-21T12:00:00.000Z",
    station: "hbw",
    code: 1,
    description: "Ready",
    active: 1,
  }, "f/i/state/hbw");
  assert.equal(ready.ok, true);
  assert.equal(ready.normalized.state, "READY");
  const unknown = normalizeStationState({ ...ready.normalized, code: 5 }, "f/i/state/hbw");
  assert.equal(unknown.ok, false);
});

test("aceita active boolean e campos vazios sem inferir estado fora de code", () => {
  for (const active of [false, true]) {
    const result = normalizeStationState({
      ts: "2026-07-22T12:00:00.000Z",
      station: "hbw",
      code: 1,
      description: "",
      active,
      target: "",
    }, "f/i/state/hbw");
    assert.equal(result.ok, true);
    assert.equal(result.normalized.state, "READY");
    assert.equal(result.normalized.active, active);
    assert.equal(result.normalized.description, "");
    assert.equal(result.normalized.target, "");
    assert.equal(result.normalized.raw.active, active);
  }
});
