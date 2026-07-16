(function createFactoryMqttService() {
  const CONFIG = window.FACTORY_DEMO_CONFIG;
  const listeners = new Map();
  let client = null;
  let connected = false;
  let connecting = false;
  let manuallyStopped = false;
  let attempt = 0;
  let lastAttemptAt = null;
  let connectedAt = null;
  let lastDisconnectedAt = null;
  let lastError = null;
  let mixedContent = false;

  function debugInfo(message, data) {
    if (CONFIG.debug) console.info(`[Factory Demo][MQTT] ${message}`, data ?? "");
  }

  function debugWarn(message, data) {
    if (CONFIG.debug) console.warn(`[Factory Demo][MQTT] ${message}`, data ?? "");
  }

  function debugError(message, error) {
    console.error(`[Factory Demo][MQTT] ${message}`, error ?? "");
  }

  function on(eventName, handler) {
    if (!listeners.has(eventName)) listeners.set(eventName, new Set());
    listeners.get(eventName).add(handler);
    return () => listeners.get(eventName)?.delete(handler);
  }

  function emit(eventName, detail = {}) {
    listeners.get(eventName)?.forEach((handler) => {
      try {
        handler(detail);
      } catch (error) {
        debugError(`Falha no listener ${eventName}`, error);
      }
    });
  }

  function randomSuffix() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const random = Math.random().toString(36).slice(2, 10);
    return `${Date.now().toString(36)}${random}`.slice(-12);
  }

  const clientId = `${CONFIG.mqtt.clientIdPrefix}-${randomSuffix()}`;

  function parseBrokerUrl() {
    let parsed;
    try {
      parsed = new URL(CONFIG.mqtt.url);
    } catch (cause) {
      const error = new TypeError("A URL configurada para o broker é inválida.", { cause });
      error.kind = "invalid-url";
      throw error;
    }

    if (!['ws:', 'wss:'].includes(parsed.protocol)) {
      const error = new TypeError("No navegador, o broker deve usar WS ou WSS.");
      error.kind = "invalid-protocol";
      throw error;
    }

    mixedContent = window.location.protocol === "https:" && parsed.protocol === "ws:";
    if (mixedContent) {
      const error = new Error(
        "A página usa HTTPS, mas o broker está configurado sem segurança (WS). Configure um endpoint WSS para continuar.",
      );
      error.kind = "mixed-content";
      throw error;
    }

    return parsed;
  }

  function safeBrokerUrl() {
    try {
      const url = new URL(CONFIG.mqtt.url);
      url.username = "";
      url.password = "";
      return url.toString();
    } catch (_error) {
      return CONFIG.mqtt.url;
    }
  }

  function describeError(error) {
    const text = String(error?.message || error || "Erro desconhecido");
    const lower = text.toLowerCase();
    let kind = error?.kind || "connection";
    let userMessage = "Não foi possível acessar o broker.";

    if (kind === "mixed-content") {
      userMessage = "A página usa HTTPS e exige conexão WSS.";
    } else if (kind === "invalid-url") {
      userMessage = "A URL configurada para o broker é inválida.";
    } else if (kind === "invalid-protocol") {
      userMessage = "No navegador, configure o broker com WS ou WSS.";
    } else if (kind === "library-missing") {
      userMessage = "A biblioteca de comunicação MQTT não foi carregada.";
    } else if (lower.includes("timeout")) {
      kind = "timeout";
      userMessage = "O broker não respondeu dentro do tempo esperado.";
    } else if (lower.includes("refused") || lower.includes("econnrefused")) {
      kind = "connection-refused";
      userMessage = "O broker recusou a conexão. Verifique a rede e a porta configurada.";
    } else if (navigator.onLine === false) {
      kind = "network-offline";
      userMessage = "O aparelho está sem acesso à rede.";
    }

    return { kind, message: text, userMessage, at: Date.now() };
  }

  function recordAttempt(source) {
    attempt += 1;
    lastAttemptAt = Date.now();
    connecting = true;
    const detail = { attempt, at: lastAttemptAt, source, clientId, brokerUrl: safeBrokerUrl() };
    debugInfo("Tentativa de conexão", detail);
    emit("attempt", detail);
  }

  function subscribeDemoStatus() {
    if (!CONFIG.demoFactory.statusEnabled || !client?.connected) return;
    client.subscribe(CONFIG.topics.demoStatus, { qos: 0 }, (error, granted) => {
      if (error) {
        const normalized = describeError(error);
        debugError("Falha ao assinar o status do simulador", error);
        emit("subscription-error", normalized);
        return;
      }
      debugInfo("Status do simulador assinado", granted);
      emit("subscribed", { topic: CONFIG.topics.demoStatus, granted });
    });
  }

  function bindClientEvents(activeClient) {
    activeClient.on("connect", (packet) => {
      if (client !== activeClient) return;
      connected = true;
      connecting = false;
      connectedAt = Date.now();
      lastError = null;
      debugInfo("Conectado", { clientId, sessionPresent: Boolean(packet?.sessionPresent) });
      emit("connect", { clientId, connectedAt, attempt, packet });
      subscribeDemoStatus();
    });

    activeClient.on("reconnect", () => {
      if (client !== activeClient || manuallyStopped) return;
      connected = false;
      recordAttempt("mqtt-reconnect");
      emit("reconnect", { attempt, at: lastAttemptAt });
    });

    activeClient.on("offline", () => {
      if (client !== activeClient) return;
      connected = false;
      connecting = false;
      lastDisconnectedAt = Date.now();
      debugWarn("Cliente offline");
      emit("offline", { at: lastDisconnectedAt });
    });

    activeClient.on("close", () => {
      if (client !== activeClient) return;
      const wasConnected = connected;
      connected = false;
      connecting = false;
      lastDisconnectedAt = Date.now();
      debugWarn("Transporte fechado", { wasConnected, manuallyStopped });
      emit("close", { at: lastDisconnectedAt, wasConnected, manuallyStopped });
    });

    activeClient.on("error", (error) => {
      if (client !== activeClient) return;
      lastError = describeError(error);
      debugError("Erro de conexão", error);
      emit("error", lastError);
    });

    activeClient.on("message", (topic, message, packet) => {
      if (client !== activeClient) return;
      const text = typeof message === "string" ? message : message.toString("utf8");
      debugInfo("Mensagem recebida", { topic, text, retain: Boolean(packet?.retain) });
      emit("message", { topic, text, packet });
    });
  }

  function stopExistingClient() {
    if (!client) return;
    const previous = client;
    client = null;
    connected = false;
    connecting = false;
    try {
      previous.removeAllListeners();
      previous.end(true);
    } catch (error) {
      debugWarn("Falha ao encerrar cliente anterior", error);
    }
  }

  function connect() {
    manuallyStopped = false;
    mixedContent = false;
    stopExistingClient();
    recordAttempt("preflight");

    if (!window.mqtt?.connect) {
      const missing = new Error("MQTT.js não está disponível em window.mqtt.");
      missing.kind = "library-missing";
      lastError = describeError(missing);
      emit("error", lastError);
      throw missing;
    }

    let parsed;
    try {
      parsed = parseBrokerUrl();
    } catch (error) {
      lastError = describeError(error);
      if (error.kind === "mixed-content") emit("mixed-content", lastError);
      else emit("error", lastError);
      throw error;
    }

    const options = {
      protocolVersion: CONFIG.mqtt.protocolVersion,
      clientId,
      clean: CONFIG.mqtt.clean,
      keepalive: CONFIG.mqtt.keepaliveSeconds,
      connectTimeout: CONFIG.mqtt.connectTimeoutMs,
      reconnectPeriod: CONFIG.mqtt.reconnectPeriodMs,
      queueQoSZero: false,
      resubscribe: false,
    };
    if (CONFIG.mqtt.username) options.username = CONFIG.mqtt.username;
    if (CONFIG.mqtt.password) options.password = CONFIG.mqtt.password;

    debugInfo("Criando cliente", {
      url: safeBrokerUrl(),
      protocolVersion: options.protocolVersion,
      clientId,
      reconnectPeriod: options.reconnectPeriod,
      queueQoSZero: options.queueQoSZero,
    });

    client = window.mqtt.connect(parsed.toString(), options);
    bindClientEvents(client);
    return client;
  }

  function disconnect() {
    manuallyStopped = true;
    if (!client) return;
    const activeClient = client;
    client = null;
    connected = false;
    connecting = false;
    activeClient.end(true, {}, () => emit("disconnect", { at: Date.now(), manual: true }));
  }

  function publishOrder(message) {
    return new Promise((resolve, reject) => {
      if (!client?.connected || !connected) {
        const error = new Error("A conexão caiu antes do envio.");
        error.kind = "not-connected";
        reject(error);
        return;
      }

      client.publish(
        CONFIG.topics.orderSend,
        message,
        { qos: CONFIG.order.qos, retain: false },
        (error) => {
          if (error) {
            error.kind = error.kind || "publish";
            debugError("Falha ao publicar ordem", error);
            reject(error);
            return;
          }
          debugInfo("Ordem entregue ao transporte", {
            topic: CONFIG.topics.orderSend,
            qos: CONFIG.order.qos,
            retain: false,
          });
          resolve({ topic: CONFIG.topics.orderSend, qos: CONFIG.order.qos, retain: false });
        },
      );
    });
  }

  function getDiagnostics() {
    let protocol = null;
    try {
      protocol = new URL(CONFIG.mqtt.url).protocol.replace(":", "").toUpperCase();
    } catch (_error) {
      protocol = "INVÁLIDO";
    }

    return {
      brokerUrl: safeBrokerUrl(),
      protocol,
      clientId,
      connected: Boolean(client?.connected && connected),
      connecting,
      attempt,
      lastAttemptAt,
      connectedAt,
      lastDisconnectedAt,
      lastError,
      navigatorOnline: navigator.onLine,
      mixedContent,
      mqttJsAvailable: Boolean(window.mqtt?.connect),
      reconnectPeriodMs: CONFIG.mqtt.reconnectPeriodMs,
      queueQoSZero: false,
      credentialsConfigured: Boolean(CONFIG.mqtt.username || CONFIG.mqtt.password),
    };
  }

  window.FactoryMqttService = Object.freeze({
    on,
    connect,
    disconnect,
    publishOrder,
    getDiagnostics,
  });
})();
