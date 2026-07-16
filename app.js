(function startFactoryDemo() {
  const CONFIG = window.FACTORY_DEMO_CONFIG;
  const FactoryTimestamp = window.FactoryTimestamp;
  const MqttService = window.FactoryMqttService;

  const pieces = [
    { type: "WHITE", name: "Peça Branca", adjective: "BRANCA", className: "piece-white" },
    { type: "RED", name: "Peça Vermelha", adjective: "VERMELHA", className: "piece-red" },
    { type: "BLUE", name: "Peça Azul", adjective: "AZUL", className: "piece-blue" },
  ];

  const state = {
    screen: "connection",
    connection: {
      status: "idle",
      startedAt: Date.now(),
      minimumHomeElapsed: false,
      attempt: 0,
      hasConnected: false,
      outageActive: false,
      connectedAt: null,
      lastDisconnectedAt: null,
      lastError: null,
      detailsExpanded: false,
      clientId: "",
      brokerUrl: CONFIG.mqtt.url,
      lastAttemptAt: null,
      userMessage: null,
    },
    carousel: {
      selectedIndex: 0,
      focusTarget: "card",
      animating: false,
    },
    confirmation: {
      open: false,
      type: null,
      selectedAction: "cancel",
      opener: null,
    },
    order: {
      status: "idle",
      type: null,
      startedAt: null,
      lockedUntil: null,
      remainingSeconds: 0,
      demoFactoryStatus: null,
      error: null,
    },
    navigation: {
      pointerStart: null,
      suppressClickUntil: 0,
    },
  };

  const dom = {
    app: document.querySelector("#displayApp"),
    connectionScreen: document.querySelector("#connectionScreen"),
    orderScreen: document.querySelector("#orderScreen"),
    connectionLive: document.querySelector("#connectionLive"),
    orderLive: document.querySelector("#orderLive"),
    connectionConsole: document.querySelector("#connectionConsole"),
    connectionPill: document.querySelector("#connectionPill"),
    connectionPillText: document.querySelector("#connectionPillText"),
    connectionTitle: document.querySelector("#connectionTitle"),
    connectionDescription: document.querySelector("#connectionDescription"),
    connectionDetails: document.querySelector("#connectionDetails"),
    detailsToggle: document.querySelector("#detailsToggle"),
    detailsToggleLabel: document.querySelector("#detailsToggleLabel"),
    detailsSecurityBadge: document.querySelector("#detailsSecurityBadge"),
    detailBroker: document.querySelector("#detailBroker"),
    detailClientId: document.querySelector("#detailClientId"),
    detailAttempt: document.querySelector("#detailAttempt"),
    detailState: document.querySelector("#detailState"),
    detailLastAttempt: document.querySelector("#detailLastAttempt"),
    detailNextAttempt: document.querySelector("#detailNextAttempt"),
    detailOnline: document.querySelector("#detailOnline"),
    detailPageProtocol: document.querySelector("#detailPageProtocol"),
    detailLastError: document.querySelector("#detailLastError"),
    cards: Array.from(document.querySelectorAll("[data-card-type]")),
    previousButton: document.querySelector("#previousButton"),
    nextButton: document.querySelector("#nextButton"),
    selectedName: document.querySelector("#selectedName"),
    selectedType: document.querySelector("#selectedType"),
    orderButton: document.querySelector("#orderButton"),
    factoryFeedback: document.querySelector("#factoryFeedback"),
    connectionChip: document.querySelector("#connectionChip"),
    connectionChipText: document.querySelector("#connectionChipText"),
    modalLayer: document.querySelector("#modalLayer"),
    confirmationDialog: document.querySelector("#confirmationDialog"),
    confirmationDescription: document.querySelector("#confirmationDescription"),
    modalPiece: document.querySelector("#modalPiece"),
    modalType: document.querySelector("#modalType"),
    cancelButton: document.querySelector("#cancelButton"),
    confirmButton: document.querySelector("#confirmButton"),
    toast: document.querySelector("#toast"),
    toastIcon: document.querySelector("#toastIcon"),
    toastMessage: document.querySelector("#toastMessage"),
    brandLogos: Array.from(document.querySelectorAll(".brand-mark img")),
  };

  let toastTimer = null;
  let homeTimer = null;
  let detailsTimer = null;
  let lockTimer = null;
  let preflightRetryTimer = null;
  let publishGeneration = 0;
  let lastLossHandledAt = 0;

  function debugInfo(message, data) {
    if (CONFIG.debug) console.info(`[Factory Demo][App] ${message}`, data ?? "");
  }

  function debugWarn(message, data) {
    if (CONFIG.debug) console.warn(`[Factory Demo][App] ${message}`, data ?? "");
  }

  function debugError(message, error) {
    console.error(`[Factory Demo][App] ${message}`, error ?? "");
  }

  function showToast(message, kind = "info") {
    const icons = { success: "✓", warning: "!", error: "×", info: "•", left: "←", right: "→" };
    window.clearTimeout(toastTimer);
    dom.toastIcon.textContent = icons[kind] || icons.info;
    dom.toastMessage.textContent = message;
    dom.toast.classList.remove("is-visible");
    void dom.toast.offsetWidth;
    dom.toast.classList.add("is-visible");
    toastTimer = window.setTimeout(
      () => dom.toast.classList.remove("is-visible"),
      CONFIG.ui.toastDurationMs,
    );
  }

  function selectedPiece() {
    return pieces[state.carousel.selectedIndex];
  }

  function isOrderLocked() {
    return ["publishing", "in-progress"].includes(state.order.status);
  }

  function isConnected() {
    return MqttService.getDiagnostics().connected;
  }

  function pendingConnectionStatus() {
    if (navigator.onLine === false) return "offline";
    return state.connection.hasConnected ? "reconnecting" : "connecting";
  }

  function renderScreens() {
    const connectionActive = state.screen === "connection";
    dom.connectionScreen.classList.toggle("is-active", connectionActive);
    dom.connectionScreen.setAttribute("aria-hidden", String(!connectionActive));
    dom.orderScreen.classList.toggle("is-active", !connectionActive);
    dom.orderScreen.setAttribute("aria-hidden", String(connectionActive || state.confirmation.open));
    syncTabStops();
  }

  function connectionPresentation() {
    const presentations = {
      idle: ["CONECTANDO", "Iniciando comunicação", "Estabelecendo comunicação com o sistema…"],
      connecting: ["CONECTANDO", "Buscando a fábrica", "Estabelecendo comunicação com o sistema…"],
      connected: ["CONECTADO", "Comunicação estabelecida", "Preparando interface…"],
      reconnecting: [
        "RECONECTANDO",
        "Restabelecendo comunicação",
        "Comunicação interrompida. Nova tentativa automática…",
      ],
      offline: [
        "SISTEMA INDISPONÍVEL",
        "Fábrica fora de alcance",
        "As tentativas continuarão automaticamente.",
      ],
      error: [
        "SISTEMA INDISPONÍVEL",
        "Não foi possível acessar o broker",
        "Verifique a rede e a porta configurada. As tentativas continuarão automaticamente.",
      ],
      "mixed-content": [
        "CONFIGURAÇÃO INCOMPATÍVEL",
        "A página usa HTTPS e exige WSS",
        "Configure um endpoint WSS para continuar.",
      ],
    };
    return presentations[state.connection.status] || presentations.idle;
  }

  function formatElapsed(timestamp) {
    if (!timestamp) return "—";
    const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
    if (seconds < 1) return "agora";
    return `${seconds.toFixed(seconds < 10 ? 1 : 0).replace(".", ",")} s`;
  }

  function renderConnection() {
    const [pill, title, defaultDescription] = connectionPresentation();
    const diagnostics = MqttService.getDiagnostics();
    const description = state.connection.userMessage || state.connection.lastError?.userMessage || defaultDescription;

    dom.connectionConsole.dataset.status = state.connection.status;
    dom.connectionPill.className = `status-pill is-${state.connection.status}`;
    dom.connectionPillText.textContent = pill;
    dom.connectionTitle.textContent = title;
    dom.connectionDescription.textContent = description;
    dom.connectionLive.textContent = `${pill}. ${description}`;

    dom.connectionConsole.classList.toggle("is-expanded", state.connection.detailsExpanded);
    dom.connectionDetails.setAttribute("aria-hidden", String(!state.connection.detailsExpanded));
    dom.detailsToggle.setAttribute("aria-expanded", String(state.connection.detailsExpanded));
    dom.detailsToggleLabel.textContent = state.connection.detailsExpanded
      ? "ocultar detalhes"
      : "detalhes da conexão";

    dom.detailsSecurityBadge.textContent = diagnostics.protocol || "—";
    dom.detailBroker.textContent = diagnostics.brokerUrl || "—";
    dom.detailBroker.title = diagnostics.brokerUrl || "";
    dom.detailClientId.textContent = diagnostics.clientId || "—";
    dom.detailClientId.title = diagnostics.clientId || "";
    dom.detailAttempt.textContent = String(diagnostics.attempt || state.connection.attempt || 0);
    dom.detailState.textContent = state.connection.status;
    dom.detailLastAttempt.textContent = formatElapsed(diagnostics.lastAttemptAt);

    if (diagnostics.connected) {
      dom.detailNextAttempt.textContent = "—";
    } else if (diagnostics.lastAttemptAt) {
      const remaining = Math.max(0, diagnostics.reconnectPeriodMs - (Date.now() - diagnostics.lastAttemptAt));
      dom.detailNextAttempt.textContent = `≈ ${(remaining / 1000).toFixed(1).replace(".", ",")} s`;
    } else {
      dom.detailNextAttempt.textContent = "≈ 2,0 s";
    }

    dom.detailOnline.textContent = navigator.onLine ? "online" : "offline";
    dom.detailPageProtocol.textContent = window.location.protocol || "—";
    dom.detailLastError.textContent = state.connection.lastError?.message || "Nenhum erro registrado.";
    dom.detailLastError.title = state.connection.lastError?.message || "";
  }

  function cardPosition(index) {
    if (index === state.carousel.selectedIndex) return "center";
    const previous = (state.carousel.selectedIndex - 1 + pieces.length) % pieces.length;
    return index === previous ? "left" : "right";
  }

  function renderCarousel() {
    dom.cards.forEach((card, index) => {
      const position = cardPosition(index);
      const piece = pieces[index];
      card.classList.remove("position-left", "position-center", "position-right", "is-focus-target");
      card.classList.add(`position-${position}`);
      card.classList.toggle(
        "is-focus-target",
        position === "center" && state.carousel.focusTarget === "card" && !isOrderLocked(),
      );
      const positionLabel = position === "center" ? "selecionada" : position === "left" ? "anterior" : "próxima";
      card.setAttribute("aria-label", `${piece.name.toLowerCase()}, ${positionLabel}`);
      card.setAttribute("aria-current", position === "center" ? "true" : "false");
      card.setAttribute("aria-disabled", String(isOrderLocked()));
    });

    const piece = selectedPiece();
    dom.selectedName.textContent = piece.name;
    dom.selectedType.textContent = piece.type;
  }

  function factoryStatusCopy() {
    const labels = {
      RECEIVED: "Simulador: recebido",
      ACCEPTED: "Simulador: aceito",
      COMPLETED: "Simulador: concluído",
      REJECTED: "Simulador: pedido rejeitado",
    };
    if (state.order.demoFactoryStatus) return labels[state.order.demoFactoryStatus] || "Resposta inválida do simulador";
    if (state.order.status === "publishing") return "Enviando ordem ao transporte…";
    if (state.order.status === "in-progress") return "Aguardando retorno do simulador";
    if (state.order.status === "error" && state.order.error) return state.order.error;
    return CONFIG.demoFactory.statusEnabled ? "Simulador pronto para receber" : "Retorno do simulador desativado";
  }

  function renderOrder() {
    const locked = isOrderLocked();
    const chipStatus = isConnected() ? "connected" : state.connection.status;
    const chipLabels = {
      connected: "ONLINE",
      connecting: "CONECTANDO",
      reconnecting: "RECONECTANDO",
      offline: "OFFLINE",
      error: "ERRO",
      "mixed-content": "ERRO",
    };
    dom.orderScreen.classList.toggle("is-in-progress", state.order.status === "in-progress");
    dom.connectionChip.dataset.status = chipStatus;
    dom.connectionChipText.textContent = chipLabels[chipStatus] || "OFFLINE";
    dom.orderButton.disabled = locked;
    dom.orderButton.setAttribute("aria-disabled", String(locked));
    dom.orderButton.classList.toggle(
      "is-focus-target",
      state.carousel.focusTarget === "order-button" && !locked,
    );

    if (state.order.status === "publishing") dom.orderButton.textContent = "ENVIANDO…";
    else if (state.order.status === "in-progress") {
      dom.orderButton.textContent = `EM PROGRESSO · ${state.order.remainingSeconds} s`;
    } else if (state.order.status === "error") dom.orderButton.textContent = "TENTAR NOVAMENTE";
    else dom.orderButton.textContent = "REQUISITAR";

    dom.factoryFeedback.textContent = factoryStatusCopy();

    renderCarousel();
    syncTabStops();
  }

  function renderModal() {
    dom.modalLayer.hidden = !state.confirmation.open;
    if (!state.confirmation.open) return;

    const piece = pieces.find((item) => item.type === state.confirmation.type) || selectedPiece();
    dom.confirmationDescription.textContent = `Deseja requisitar uma unidade da peça ${piece.adjective}?`;
    dom.modalType.textContent = piece.type;
    dom.modalPiece.classList.remove("piece-white", "piece-red", "piece-blue");
    dom.modalPiece.classList.add(piece.className);
    dom.cancelButton.classList.toggle("is-selected", state.confirmation.selectedAction === "cancel");
    dom.confirmButton.classList.toggle("is-selected", state.confirmation.selectedAction === "confirm");
    dom.orderScreen.inert = true;
  }

  function render() {
    renderScreens();
    renderConnection();
    renderOrder();
    renderModal();
  }

  function syncTabStops() {
    dom.detailsToggle.tabIndex = state.screen === "connection" ? 0 : -1;
    dom.cards.forEach((card, index) => {
      const central = index === state.carousel.selectedIndex;
      card.tabIndex = state.screen === "order" && central && state.carousel.focusTarget === "card" && !isOrderLocked() && !state.confirmation.open ? 0 : -1;
    });
    dom.orderButton.tabIndex = state.screen === "order" && state.carousel.focusTarget === "order-button" && !isOrderLocked() && !state.confirmation.open ? 0 : -1;
    dom.cancelButton.tabIndex = state.confirmation.open ? 0 : -1;
    dom.confirmButton.tabIndex = state.confirmation.open ? 0 : -1;
  }

  function focusOrderTarget() {
    window.setTimeout(() => {
      if (state.screen !== "order" || state.confirmation.open || isOrderLocked()) {
        dom.app.focus({ preventScroll: true });
        return;
      }
      const target = state.carousel.focusTarget === "card"
        ? dom.cards[state.carousel.selectedIndex]
        : dom.orderButton;
      target?.focus({ preventScroll: true });
    }, 0);
  }

  function setFocusTarget(target, focus = true) {
    if (!['card', 'order-button'].includes(target) || isOrderLocked()) return;
    state.carousel.focusTarget = target;
    renderOrder();
    if (focus) focusOrderTarget();
  }

  function resetOrderReady() {
    window.clearInterval(lockTimer);
    lockTimer = null;
    state.order.status = "idle";
    state.order.type = null;
    state.order.startedAt = null;
    state.order.lockedUntil = null;
    state.order.remainingSeconds = 0;
    state.order.demoFactoryStatus = null;
    state.order.error = null;
  }

  function enterOrderScreenIfReady() {
    if (!state.connection.minimumHomeElapsed || !isConnected()) return false;
    window.clearTimeout(homeTimer);
    state.screen = "order";
    state.connection.detailsExpanded = false;
    state.connection.userMessage = null;
    resetOrderReady();
    render();
    focusOrderTarget();
    debugInfo("Interface de pedidos liberada");
    return true;
  }

  function beginHomeCycle(message = null) {
    window.clearTimeout(homeTimer);
    state.screen = "connection";
    state.connection.startedAt = Date.now();
    state.connection.minimumHomeElapsed = false;
    state.connection.detailsExpanded = false;
    state.connection.userMessage = message;
    homeTimer = window.setTimeout(() => {
      state.connection.minimumHomeElapsed = true;
      enterOrderScreenIfReady();
    }, CONFIG.ui.minimumHomeDurationMs);
    render();
    window.setTimeout(() => dom.detailsToggle.focus({ preventScroll: true }), 0);
  }

  function rotateCarousel(step) {
    if (
      state.screen !== "order" ||
      state.carousel.animating ||
      state.confirmation.open ||
      isOrderLocked()
    ) return false;

    state.carousel.animating = true;
    state.carousel.selectedIndex = (state.carousel.selectedIndex + step + pieces.length) % pieces.length;
    renderOrder();
    window.setTimeout(() => {
      state.carousel.animating = false;
      focusOrderTarget();
    }, CONFIG.interaction.carouselDurationMs);
    return true;
  }

  function canOpenConfirmation() {
    return state.screen === "order" && isConnected() && !isOrderLocked() && !state.confirmation.open;
  }

  function openConfirmation(type = selectedPiece().type, opener = document.activeElement) {
    if (!canOpenConfirmation()) {
      if (!isConnected()) showToast("A conexão com a fábrica não está ativa.", "error");
      else if (isOrderLocked()) showToast("Aguarde a liberação da solicitação atual.", "warning");
      return false;
    }

    const pieceIndex = pieces.findIndex((piece) => piece.type === type);
    if (pieceIndex < 0 || pieceIndex !== state.carousel.selectedIndex) return false;

    state.confirmation.open = true;
    state.confirmation.type = type;
    state.confirmation.selectedAction = "cancel";
    state.confirmation.opener = opener instanceof HTMLElement ? opener : null;
    render();
    window.setTimeout(() => dom.cancelButton.focus({ preventScroll: true }), 0);
    return true;
  }

  function closeConfirmation({ restoreFocus = true } = {}) {
    const opener = state.confirmation.opener;
    state.confirmation.open = false;
    state.confirmation.type = null;
    state.confirmation.selectedAction = "cancel";
    state.confirmation.opener = null;
    dom.orderScreen.inert = false;
    render();
    if (restoreFocus) {
      window.setTimeout(() => {
        if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
        else focusOrderTarget();
      }, 0);
    }
  }

  function setModalAction(action, focus = true) {
    if (!state.confirmation.open || !['cancel', 'confirm'].includes(action)) return;
    state.confirmation.selectedAction = action;
    renderModal();
    if (focus) {
      const button = action === "cancel" ? dom.cancelButton : dom.confirmButton;
      button.focus({ preventScroll: true });
    }
  }

  function validateOrderPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const keys = Object.keys(payload);
    return (
      keys.length === 2 &&
      keys[0] === "type" &&
      keys[1] === "ts" &&
      CONFIG.order.validTypes.includes(payload.type) &&
      typeof payload.ts === "string" &&
      FactoryTimestamp.isValid(payload.ts)
    );
  }

  function buildOrderPayload(type, nowMs = Date.now()) {
    if (!CONFIG.order.validTypes.includes(type)) throw new TypeError(`Tipo de peça inválido: ${type}`);
    const payload = { type, ts: FactoryTimestamp.create(nowMs) };
    if (!validateOrderPayload(payload)) throw new TypeError("O payload da ordem não atende ao contrato.");
    return payload;
  }

  function finishOrderLock() {
    window.clearInterval(lockTimer);
    lockTimer = null;
    resetOrderReady();
    renderOrder();
    showToast("Nova solicitação liberada", "success");
    dom.orderLive.textContent = "Nova solicitação liberada.";
    focusOrderTarget();
  }

  function updateOrderCountdown() {
    if (state.order.status !== "in-progress" || !state.order.lockedUntil) return;
    const remainingMs = state.order.lockedUntil - Date.now();
    if (remainingMs <= 0) {
      finishOrderLock();
      return;
    }
    const seconds = Math.ceil(remainingMs / 1000);
    if (seconds !== state.order.remainingSeconds) {
      state.order.remainingSeconds = seconds;
      renderOrder();
    }
  }

  function startOrderLock(type) {
    state.order.status = "in-progress";
    state.order.type = type;
    state.order.startedAt = Date.now();
    state.order.lockedUntil = state.order.startedAt + CONFIG.order.lockDurationMs;
    state.order.remainingSeconds = Math.ceil(CONFIG.order.lockDurationMs / 1000);
    state.order.error = null;
    renderOrder();
    dom.orderLive.textContent = `Pedido ${type} enviado. Novas solicitações bloqueadas por 10 segundos.`;
    window.clearInterval(lockTimer);
    lockTimer = window.setInterval(updateOrderCountdown, 200);
  }

  async function confirmOrder() {
    if (!state.confirmation.open || state.confirmation.selectedAction !== "confirm") return false;
    const type = state.confirmation.type;
    if (
      type !== selectedPiece().type ||
      !CONFIG.order.validTypes.includes(type) ||
      !isConnected() ||
      isOrderLocked()
    ) {
      closeConfirmation({ restoreFocus: false });
      showToast("A conexão caiu antes do envio.", "error");
      if (!isConnected()) handleConnectionLost("A conexão caiu antes do envio. Nenhum pedido foi enviado.");
      return false;
    }

    state.order.status = "publishing";
    state.order.type = type;
    state.order.startedAt = Date.now();
    state.order.demoFactoryStatus = null;
    state.order.error = null;
    const operation = ++publishGeneration;
    closeConfirmation({ restoreFocus: false });
    renderOrder();

    try {
      const payload = buildOrderPayload(type);
      const serialized = JSON.stringify(payload);
      await MqttService.publishOrder(serialized);
      if (operation !== publishGeneration || !isConnected()) return false;
      startOrderLock(type);
      debugInfo("Ordem publicada", {
        topic: CONFIG.topics.orderSend,
        payload,
        qos: CONFIG.order.qos,
        retain: false,
      });
      return true;
    } catch (error) {
      if (operation !== publishGeneration) return false;
      debugError("Falha ao publicar ordem", error);
      state.order.status = "error";
      state.order.lockedUntil = null;
      state.order.remainingSeconds = 0;
      state.order.error = error?.message || "Não foi possível enviar o pedido.";
      renderOrder();
      showToast("Não foi possível enviar o pedido.", "error");
      if (!isConnected()) handleConnectionLost("A conexão caiu antes do envio. O pedido não foi reenviado.");
      return false;
    }
  }

  function cancelOrderLockForLoss() {
    window.clearInterval(lockTimer);
    lockTimer = null;
    publishGeneration += 1;
    const interrupted = ["publishing", "in-progress"].includes(state.order.status);
    state.order.status = interrupted ? "interrupted" : "idle";
    state.order.lockedUntil = null;
    state.order.remainingSeconds = 0;
    state.order.demoFactoryStatus = null;
    state.order.error = interrupted ? "Conexão perdida. O pedido não foi reenviado." : null;
    return interrupted;
  }

  function handleConnectionLost(message = null) {
    const now = Date.now();
    if (!state.connection.hasConnected) {
      state.connection.status = pendingConnectionStatus();
      if (message && navigator.onLine === false) state.connection.userMessage = message;
      renderConnection();
      return;
    }

    if (state.connection.outageActive) {
      state.connection.status = pendingConnectionStatus();
      if (message) state.connection.userMessage = message;
      renderConnection();
      return;
    }

    if (now - lastLossHandledAt < 150 && state.screen === "connection") return;
    lastLossHandledAt = now;
    state.connection.outageActive = true;
    const interrupted = cancelOrderLockForLoss();
    if (state.confirmation.open) closeConfirmation({ restoreFocus: false });
    state.connection.status = pendingConnectionStatus();
    state.connection.lastDisconnectedAt = now;
    beginHomeCycle(
      message || (interrupted
        ? "Conexão perdida. O pedido não foi reenviado."
        : "Comunicação interrompida. Nova tentativa automática…"),
    );
  }

  function parseDemoStatus(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new TypeError("Resposta do simulador não contém JSON válido.", { cause: error });
    }

    const allowed = ["RECEIVED", "ACCEPTED", "COMPLETED", "REJECTED"];
    if (!data || typeof data !== "object" || Array.isArray(data) || !allowed.includes(data.status)) {
      throw new TypeError("Status do simulador não reconhecido.");
    }
    if (typeof data.ts !== "string" || !FactoryTimestamp.isValid(data.ts)) {
      throw new TypeError("Timestamp do simulador inválido.");
    }
    if (data.status === "REJECTED") {
      if (data.type !== null || data.reason !== "INVALID_PAYLOAD") {
        throw new TypeError("Resposta de rejeição inválida.");
      }
    } else if (!CONFIG.order.validTypes.includes(data.type)) {
      throw new TypeError("Tipo de peça inválido no status do simulador.");
    }
    return data;
  }

  function handleDemoMessage({ topic, text }) {
    if (!CONFIG.demoFactory.statusEnabled || topic !== CONFIG.topics.demoStatus) return;
    try {
      const data = parseDemoStatus(text);
      if (data.status !== "REJECTED" && data.type !== state.order.type) {
        debugWarn("Status do simulador ignorado por não corresponder à ordem ativa", data);
        return;
      }

      state.order.demoFactoryStatus = data.status;
      if (data.status === "REJECTED") {
        publishGeneration += 1;
        window.clearInterval(lockTimer);
        lockTimer = null;
        state.order.status = "error";
        state.order.lockedUntil = null;
        state.order.remainingSeconds = 0;
        state.order.error = "Pedido rejeitado pelo simulador. Nova tentativa liberada.";
        showToast("Pedido rejeitado pelo simulador.", "error");
      }
      renderOrder();
      dom.orderLive.textContent = factoryStatusCopy();
    } catch (error) {
      debugWarn("Resposta inválida do simulador", { error, text });
      showToast("Resposta inválida do simulador.", "warning");
    }
  }

  function toggleConnectionDetails() {
    if (state.screen !== "connection") return;
    state.connection.detailsExpanded = !state.connection.detailsExpanded;
    renderConnection();
  }

  function schedulePreflightRetry() {
    window.clearTimeout(preflightRetryTimer);
    preflightRetryTimer = window.setTimeout(() => connect(), CONFIG.mqtt.reconnectPeriodMs);
  }

  function connect() {
    window.clearTimeout(preflightRetryTimer);
    if (state.screen !== "connection") beginHomeCycle();
    state.connection.status = pendingConnectionStatus();
    renderConnection();
    try {
      MqttService.connect();
      return true;
    } catch (error) {
      state.connection.lastError = {
        kind: error.kind || "connection",
        message: error.message || String(error),
        userMessage: error.kind === "mixed-content"
          ? "A página usa HTTPS e exige conexão WSS."
          : "Não foi possível acessar o broker.",
      };
      state.connection.status = error.kind === "mixed-content" ? "mixed-content" : pendingConnectionStatus();
      renderConnection();
      schedulePreflightRetry();
      return false;
    }
  }

  function disconnect() {
    MqttService.disconnect();
    handleConnectionLost("Conexão encerrada. Nenhum pedido foi reenviado.");
  }

  function reconnect() {
    beginHomeCycle();
    return connect();
  }

  function getDiagnostics() {
    const mqttDiagnostics = MqttService.getDiagnostics();
    return {
      pageUrl: window.location.href,
      secureContext: window.isSecureContext,
      pageProtocol: window.location.protocol,
      brokerUrl: mqttDiagnostics.brokerUrl,
      brokerProtocol: mqttDiagnostics.protocol,
      clientId: mqttDiagnostics.clientId,
      connected: mqttDiagnostics.connected,
      attempts: mqttDiagnostics.attempt,
      navigatorOnline: navigator.onLine,
      mixedContent: mqttDiagnostics.mixedContent,
      screen: state.screen,
      selectedType: selectedPiece().type,
      orderStatus: state.order.status,
      lastError: state.connection.lastError,
      lastDemoFactoryStatus: state.order.demoFactoryStatus,
      mqttJsAvailable: mqttDiagnostics.mqttJsAvailable,
    };
  }

  function detectSwipe(deltaX, deltaY) {
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    if (Math.max(absX, absY) < CONFIG.interaction.swipeThresholdPx) return null;
    if (absX > absY) return deltaX > 0 ? "swipe-right" : "swipe-left";
    return deltaY > 0 ? "swipe-down" : "swipe-up";
  }

  function routeModalCommand(command) {
    if (command === "swipe-left" || command === "swipe-right") {
      setModalAction(state.confirmation.selectedAction === "cancel" ? "confirm" : "cancel");
    } else if (command === "swipe-down" || command === "cancel") {
      closeConfirmation();
    } else if (command === "enter") {
      if (state.confirmation.selectedAction === "confirm") confirmOrder();
      else closeConfirmation();
    }
  }

  function routeOrderCommand(command) {
    if (command === "previous") rotateCarousel(-1);
    else if (command === "next") rotateCarousel(1);
    else if (command === "swipe-left") rotateCarousel(1);
    else if (command === "swipe-right") rotateCarousel(-1);
    else if (command === "swipe-up") setFocusTarget("card");
    else if (command === "swipe-down") setFocusTarget("order-button");
    else if (command === "enter") openConfirmation();
    else if (command === "cancel") showToast("Tela principal", "info");
  }

  function handleKeydown(event) {
    if (event.repeat) return;
    if (state.confirmation.open && event.key === "Tab") {
      event.preventDefault();
      setModalAction(
        event.shiftKey
          ? state.confirmation.selectedAction === "cancel" ? "confirm" : "cancel"
          : state.confirmation.selectedAction === "cancel" ? "confirm" : "cancel",
      );
      return;
    }

    const keyMap = {
      ArrowLeft: state.confirmation.open ? "swipe-left" : "previous",
      ArrowRight: state.confirmation.open ? "swipe-right" : "next",
      ArrowUp: "swipe-up",
      ArrowDown: "swipe-down",
      Enter: "enter",
      Escape: "cancel",
    };
    const command = keyMap[event.key];
    if (!command) return;
    event.preventDefault();

    if (state.confirmation.open) routeModalCommand(command);
    else if (state.screen === "connection") {
      if (command === "enter") toggleConnectionDetails();
    } else routeOrderCommand(command);
  }

  function handlePointerDown(event) {
    state.navigation.pointerStart = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      modal: state.confirmation.open,
    };
    if (dom.app.setPointerCapture) dom.app.setPointerCapture(event.pointerId);
  }

  function handlePointerUp(event) {
    const start = state.navigation.pointerStart;
    state.navigation.pointerStart = null;
    if (!start || start.id !== event.pointerId) return;

    const command = detectSwipe(event.clientX - start.x, event.clientY - start.y);
    if (!command) return;
    event.preventDefault();
    state.navigation.suppressClickUntil = Date.now() + CONFIG.interaction.clickSuppressionMs;

    if (start.modal && state.confirmation.open) routeModalCommand(command);
    else if (state.screen === "order") routeOrderCommand(command);
  }

  function clickAllowed() {
    return Date.now() >= state.navigation.suppressClickUntil;
  }

  function registerDomListeners() {
    dom.brandLogos.forEach((logo) => {
      logo.addEventListener("error", () => logo.closest(".brand-mark")?.classList.add("logo-failed"));
    });
    dom.detailsToggle.addEventListener("click", () => {
      if (clickAllowed()) toggleConnectionDetails();
    });
    dom.previousButton.addEventListener("click", () => {
      if (clickAllowed()) rotateCarousel(-1);
    });
    dom.nextButton.addEventListener("click", () => {
      if (clickAllowed()) rotateCarousel(1);
    });
    dom.cards.forEach((card, index) => {
      card.addEventListener("click", () => {
        if (!clickAllowed() || isOrderLocked()) return;
        const position = cardPosition(index);
        if (position === "center") openConfirmation(card.dataset.cardType, card);
        else rotateCarousel(position === "left" ? -1 : 1);
      });
    });
    dom.orderButton.addEventListener("click", () => {
      if (clickAllowed()) openConfirmation(selectedPiece().type, dom.orderButton);
    });
    dom.cancelButton.addEventListener("focus", () => {
      if (state.confirmation.open) setModalAction("cancel", false);
    });
    dom.confirmButton.addEventListener("focus", () => {
      if (state.confirmation.open) setModalAction("confirm", false);
    });
    dom.cancelButton.addEventListener("click", () => {
      if (clickAllowed()) closeConfirmation();
    });
    dom.confirmButton.addEventListener("click", () => {
      if (!clickAllowed()) return;
      state.confirmation.selectedAction = "confirm";
      confirmOrder();
    });
    dom.app.addEventListener("pointerdown", handlePointerDown);
    dom.app.addEventListener("pointerup", handlePointerUp);
    dom.app.addEventListener("pointercancel", () => {
      state.navigation.pointerStart = null;
    });
    document.addEventListener("keydown", handleKeydown);
    document.addEventListener("focusin", (event) => {
      if (state.confirmation.open && !dom.confirmationDialog.contains(event.target)) {
        const target = state.confirmation.selectedAction === "cancel" ? dom.cancelButton : dom.confirmButton;
        target.focus({ preventScroll: true });
      }
    });
    window.addEventListener("offline", () => {
      state.connection.status = "offline";
      handleConnectionLost("O aparelho está sem acesso à rede. O pedido não foi reenviado.");
    });
    window.addEventListener("online", () => {
      if (state.screen === "connection" && !isConnected()) {
        state.connection.status = pendingConnectionStatus();
        renderConnection();
      }
    });
  }

  function registerMqttListeners() {
    MqttService.on("attempt", (detail) => {
      state.connection.attempt = detail.attempt;
      state.connection.lastAttemptAt = detail.at;
      state.connection.clientId = detail.clientId;
      state.connection.brokerUrl = detail.brokerUrl;
      state.connection.status = pendingConnectionStatus();
      renderConnection();
    });
    MqttService.on("connect", (detail) => {
      state.connection.status = "connected";
      state.connection.hasConnected = true;
      state.connection.outageActive = false;
      state.connection.connectedAt = detail.connectedAt;
      state.connection.clientId = detail.clientId;
      state.connection.lastError = null;
      state.connection.userMessage = null;
      renderConnection();
      enterOrderScreenIfReady();
    });
    MqttService.on("reconnect", (detail) => {
      state.connection.status = pendingConnectionStatus();
      state.connection.attempt = detail.attempt;
      state.connection.lastAttemptAt = detail.at;
      renderConnection();
    });
    MqttService.on("offline", () => handleConnectionLost());
    MqttService.on("close", (detail) => {
      if (!detail.manuallyStopped) handleConnectionLost();
    });
    MqttService.on("error", (error) => {
      state.connection.lastError = error;
      if (!isConnected()) {
        state.connection.status = error.kind === "mixed-content" ? "mixed-content" : pendingConnectionStatus();
      }
      renderConnection();
    });
    MqttService.on("mixed-content", (error) => {
      state.connection.lastError = error;
      state.connection.status = "mixed-content";
      renderConnection();
    });
    MqttService.on("message", handleDemoMessage);
    MqttService.on("subscription-error", (error) => {
      debugWarn("Status do simulador indisponível", error);
      if (CONFIG.demoFactory.statusEnabled) showToast("Retorno do simulador indisponível.", "warning");
    });
  }

  window.__FACTORY_DEMO__ = {
    state,
    CONFIG,
    connect,
    disconnect,
    reconnect,
    getDiagnostics,
  };

  registerDomListeners();
  registerMqttListeners();
  detailsTimer = window.setInterval(() => {
    if (state.screen === "connection" && state.connection.detailsExpanded) renderConnection();
  }, 250);
  beginHomeCycle();
  state.connection.status = "connecting";
  render();
  connect();
})();
