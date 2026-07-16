(function createFactoryDemoConfig() {
  function deepFreeze(value) {
    Object.values(value).forEach((child) => {
      if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
    });
    return Object.freeze(value);
  }

  window.FACTORY_DEMO_CONFIG = deepFreeze({
    debug: true,

    mqtt: {
      url: "ws://127.0.0.1:9001",
      protocolVersion: 4,
      clientIdPrefix: "eldorado-rb-display",
      clean: true,
      keepaliveSeconds: 30,
      connectTimeoutMs: 8000,
      reconnectPeriodMs: 2000,
      queueQoSZero: false,
      username: "",
      password: "",
    },

    topics: {
      orderSend: "f/i/order",
      demoStatus: "eldorado/demo/factory/order/status",
    },

    demoFactory: {
      statusEnabled: true,
    },

    order: {
      validTypes: ["WHITE", "RED", "BLUE"],
      qos: 0,
      retain: false,
      lockDurationMs: 10000,
    },

    timestamp: {
      offsetMinutes: 725,
      fractionalDigits: 2,
    },

    interaction: {
      swipeThresholdPx: 44,
      clickSuppressionMs: 320,
      carouselDurationMs: 250,
    },

    ui: {
      minimumHomeDurationMs: 2000,
      toastDurationMs: 3200,
    },
  });
})();
