"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createConfig } = require("../src/config");

test("configura offset do timestamp com default zero, alternativa 725 e limite defensivo", () => {
  assert.equal(
    createConfig({ MODE: "test", ORDER_TIMESTAMP_OFFSET_MINUTES: "" }).order.timestampOffsetMinutes,
    0,
  );
  assert.equal(
    createConfig({ MODE: "test", ORDER_TIMESTAMP_OFFSET_MINUTES: "725" }).order.timestampOffsetMinutes,
    725,
  );
  assert.throws(
    () => createConfig({ MODE: "test", ORDER_TIMESTAMP_OFFSET_MINUTES: "1441" }),
    /ORDER_TIMESTAMP_OFFSET_MINUTES possui valor inválido/,
  );
});

test("modo factory inicia read-only e somente habilita comandos por configuração explícita", () => {
  const readOnly = createConfig({ MODE: "factory", MQTT_URL: "mqtt://192.168.0.10:1883", FACTORY_COMMANDS_ENABLED: "" });
  assert.equal(readOnly.order.commandsEnabled, false);
  assert.equal(createConfig({ MODE: "factory", MQTT_URL: "mqtt://192.168.0.10:1883", FACTORY_COMMANDS_ENABLED: "true" }).order.commandsEnabled, true);
  assert.equal(createConfig({ MODE: "simulation", FACTORY_COMMANDS_ENABLED: "" }).order.commandsEnabled, true);
});

test("simulação usa snapshots de 2 s e omite SHIPPED por padrão", () => {
  const config = createConfig({ MODE: "simulation", SIMULATION_SNAPSHOT_PERIOD_MS: "", SIMULATION_EMIT_SHIPPED: "" });
  assert.equal(config.simulation.snapshotPeriodMs, 2000);
  assert.equal(config.simulation.emitShipped, false);
  assert.equal(createConfig({ MODE: "simulation", SIMULATION_EMIT_SHIPPED: "true" }).simulation.emitShipped, true);
});

test("inferência de WAITING no bootstrap exige ativação explícita", () => {
  assert.equal(createConfig({ MODE: "factory", MQTT_URL: "mqtt://192.168.0.10:1883" }).factory.inferWaitingOnBoot, false);
  const enabled = createConfig({
    MODE: "factory",
    MQTT_URL: "mqtt://192.168.0.10:1883",
    FACTORY_INFER_WAITING_ON_BOOT: "true",
    FACTORY_BOOTSTRAP_GRACE_MS: "6000",
  });
  assert.equal(enabled.factory.inferWaitingOnBoot, true);
  assert.equal(enabled.factory.bootstrapGraceMs, 6000);
});
