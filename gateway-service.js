(function createFactoryGatewayService() {
  const CONFIG = window.FACTORY_APP_CONFIG;
  const listeners = new Map();
  let socket = null;
  let reconnectTimer = null;
  let manuallyStopped = false;
  let connecting = false;
  let connected = false;
  let attempt = 0;
  let lastAttemptAt = null;
  let connectedAt = null;
  let disconnectedAt = null;
  let lastError = null;
  let snapshot = null;

  function debug(method, message, data) {
    if (CONFIG.debug || method === "error") console[method](`[Factory Gateway][Frontend] ${message}`, data ?? "");
  }

  function on(eventName, handler) {
    if (!listeners.has(eventName)) listeners.set(eventName, new Set());
    listeners.get(eventName).add(handler);
    return () => listeners.get(eventName)?.delete(handler);
  }

  function emit(eventName, data = {}) {
    listeners.get(eventName)?.forEach((handler) => {
      try {
        handler(data);
      } catch (error) {
        debug("error", `Falha no listener ${eventName}`, error);
      }
    });
  }

  async function requestJson(path, options = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), CONFIG.gateway.requestTimeoutMs);
    try {
      const response = await fetch(path, {
        cache: "no-store",
        headers: { "content-type": "application/json", ...(options.headers || {}) },
        ...options,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({ ok: false, code: "INVALID_RESPONSE", message: "Resposta não contém JSON válido." }));
      if (!response.ok || data.ok === false) {
        const error = new Error(data.message || `Gateway respondeu HTTP ${response.status}.`);
        error.code = data.code || `HTTP_${response.status}`;
        error.details = data.details || {};
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function websocketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${CONFIG.gateway.eventsPath}`;
  }

  function applyEvent(eventName, data) {
    if (eventName === "snapshot") snapshot = data;
    else if (snapshot && eventName === "mqtt-state") snapshot.mqtt = data;
    else if (snapshot && eventName === "order-state") snapshot.order = data;
    else if (snapshot && eventName === "stock-state") snapshot.stock = data;
    else if (snapshot && eventName === "factory-order-state") {
      snapshot.order = snapshot.order || {};
      snapshot.order.factory = data;
    } else if (snapshot && eventName === "station-state") {
      snapshot.stations = snapshot.stations || {};
      snapshot.stations[data.station] = data;
    } else if (eventName === "gateway-state" && data?.mqtt) snapshot = data;
    emit(eventName, data);
    emit("state", getState());
  }

  function normalizeConnectionError(error) {
    const message = error?.name === "AbortError" ? "O gateway não respondeu dentro do tempo esperado." : error?.message || String(error);
    return { code: error?.code || (error?.name === "AbortError" ? "GATEWAY_TIMEOUT" : "GATEWAY_UNREACHABLE"), message, at: Date.now() };
  }

  function scheduleReconnect() {
    if (manuallyStopped) return;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, CONFIG.gateway.reconnectPeriodMs);
  }

  function closeSocket() {
    if (!socket) return;
    const previous = socket;
    socket = null;
    previous.onclose = null;
    previous.onerror = null;
    previous.close();
  }

  async function refresh() {
    const response = await requestJson(CONFIG.gateway.statePath, { method: "GET", headers: {} });
    snapshot = response.state;
    emit("state", getState());
    return snapshot;
  }

  async function connect() {
    if (connecting || (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState))) return;
    manuallyStopped = false;
    connecting = true;
    connected = false;
    attempt += 1;
    lastAttemptAt = Date.now();
    emit("attempt", { attempt, at: lastAttemptAt, endpoint: window.location.origin });
    closeSocket();

    try {
      await refresh();
      if (manuallyStopped) return;
      const activeSocket = new WebSocket(websocketUrl());
      socket = activeSocket;
      activeSocket.addEventListener("open", () => {
        if (socket !== activeSocket) return;
        connecting = false;
        connected = true;
        connectedAt = Date.now();
        lastError = null;
        debug("info", "WebSocket do gateway conectado", websocketUrl());
        emit("connect", { connectedAt, attempt, snapshot });
        emit("state", getState());
      });
      activeSocket.addEventListener("message", (message) => {
        if (socket !== activeSocket) return;
        try {
          const envelope = JSON.parse(message.data);
          if (!envelope || typeof envelope.event !== "string") throw new Error("Envelope sem event.");
          applyEvent(envelope.event, envelope.data);
        } catch (error) {
          debug("warn", "Evento WebSocket inválido", { error, raw: message.data });
          emit("integration-warning", { code: "INVALID_GATEWAY_EVENT", message: error.message });
        }
      });
      activeSocket.addEventListener("close", () => {
        if (socket !== activeSocket) return;
        connected = false;
        connecting = false;
        disconnectedAt = Date.now();
        socket = null;
        emit("offline", { at: disconnectedAt, manual: manuallyStopped });
        emit("state", getState());
        scheduleReconnect();
      });
      activeSocket.addEventListener("error", () => {
        if (socket !== activeSocket) return;
        lastError = normalizeConnectionError(new Error("Falha no WebSocket do gateway."));
        emit("error", lastError);
      });
    } catch (error) {
      connecting = false;
      connected = false;
      lastError = normalizeConnectionError(error);
      debug("warn", "Gateway indisponível", lastError);
      emit("error", lastError);
      emit("state", getState());
      scheduleReconnect();
    }
  }

  function disconnect() {
    manuallyStopped = true;
    window.clearTimeout(reconnectTimer);
    connecting = false;
    connected = false;
    closeSocket();
    disconnectedAt = Date.now();
    emit("disconnect", { at: disconnectedAt, manual: true });
  }

  function reconnect() {
    disconnect();
    manuallyStopped = false;
    return connect();
  }

  async function requestOrder(type) {
    if (!CONFIG.order.validTypes.includes(type)) {
      const error = new TypeError(`Tipo de peça inválido: ${type}`);
      error.code = "INVALID_TYPE";
      throw error;
    }
    const response = await requestJson(CONFIG.gateway.ordersPath, {
      method: "POST",
      body: JSON.stringify({ type }),
    });
    window.setTimeout(() => refresh().catch(() => {}), 0);
    return response.order;
  }

  function getState() {
    return snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
  }

  function getDiagnostics() {
    return {
      endpoint: window.location.origin,
      websocketUrl: websocketUrl(),
      connected,
      connecting,
      attempt,
      lastAttemptAt,
      connectedAt,
      disconnectedAt,
      lastError,
      snapshotAvailable: Boolean(snapshot),
      mqttConnected: Boolean(snapshot?.mqtt?.connected),
      mqttBrokerUrl: snapshot?.mqtt?.brokerUrl || null,
      mqttClientId: snapshot?.mqtt?.clientId || null,
      mode: snapshot?.mode || snapshot?.gateway?.mode || null,
      navigatorOnline: navigator.onLine,
    };
  }

  window.FactoryGatewayService = Object.freeze({
    connect,
    disconnect,
    getDiagnostics,
    getState,
    on,
    reconnect,
    refresh,
    requestOrder,
  });
})();
