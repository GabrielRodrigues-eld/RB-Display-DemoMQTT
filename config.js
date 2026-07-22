(function createFactoryAppConfig() {
  function deepFreeze(value) {
    Object.values(value).forEach((child) => {
      if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
    });
    return Object.freeze(value);
  }

  window.FACTORY_APP_CONFIG = deepFreeze({
    debug: true,
    gateway: {
      statePath: "/api/state",
      stockPath: "/api/stock",
      topicsPath: "/api/topics",
      topicEventsPath: "/api/events",
      ordersPath: "/api/orders",
      healthPath: "/health",
      eventsPath: "/events",
      reconnectPeriodMs: 2000,
      requestTimeoutMs: 8000,
    },
    order: {
      validTypes: ["WHITE", "RED", "BLUE"],
    },
    interaction: {
      swipeThresholdPx: 44,
      clickSuppressionMs: 320,
      carouselDurationMs: 250,
    },
    ui: {
      minimumHomeDurationMs: 1200,
      toastDurationMs: 3200,
    },
  });
})();
