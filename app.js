(function startFactoryApp() {
  const CONFIG = window.FACTORY_APP_CONFIG;
  const GatewayService = window.FactoryGatewayService;

  const pieces = [
    { type: "WHITE", name: "Peça Branca", adjective: "BRANCA", className: "piece-white" },
    { type: "RED", name: "Peça Vermelha", adjective: "VERMELHA", className: "piece-red" },
    { type: "BLUE", name: "Peça Azul", adjective: "AZUL", className: "piece-blue" },
  ];

  const state = {
    screen: "connection",
    connection: {
      status: "connecting",
      startedAt: Date.now(),
      minimumHomeElapsed: false,
      attempt: 0,
      hasConnected: false,
      outageActive: false,
      detailsExpanded: false,
      lastError: null,
      userMessage: null,
    },
    carousel: { selectedIndex: 0, focusTarget: "card", animating: false },
    confirmation: { open: false, type: null, selectedAction: "cancel", opener: null },
    order: { status: "idle", pending: null, last: null, factory: null, error: null },
    stock: {
      received: false,
      valid: false,
      inconsistent: false,
      stale: true,
      counts: { WHITE: 0, RED: 0, BLUE: 0 },
      positions: { WHITE: [], RED: [], BLUE: [] },
      lastSeen: null,
      warnings: [],
      errors: [],
    },
    gatewaySnapshot: null,
    navigation: { pointerStart: null, suppressClickUntil: 0 },
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
    selectedStockCount: document.querySelector("#selectedStockCount"),
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
  let requestGeneration = 0;
  let previousRemoteOrderStatus = "idle";

  function debugInfo(message, data) {
    if (CONFIG.debug) console.info(`[Factory Gateway][App] ${message}`, data ?? "");
  }

  function debugWarn(message, data) {
    if (CONFIG.debug) console.warn(`[Factory Gateway][App] ${message}`, data ?? "");
  }

  function debugError(message, error) {
    console.error(`[Factory Gateway][App] ${message}`, error ?? "");
  }

  function showToast(message, kind = "info") {
    const icons = { success: "✓", warning: "!", error: "×", info: "•", left: "←", right: "→" };
    window.clearTimeout(toastTimer);
    dom.toastIcon.textContent = icons[kind] || icons.info;
    dom.toastMessage.textContent = message;
    dom.toast.classList.remove("is-visible");
    void dom.toast.offsetWidth;
    dom.toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => dom.toast.classList.remove("is-visible"), CONFIG.ui.toastDurationMs);
  }

  function selectedPiece() {
    return pieces[state.carousel.selectedIndex];
  }

  function gatewayDiagnostics() {
    return GatewayService.getDiagnostics();
  }

  function isGatewayConnected() {
    return gatewayDiagnostics().connected;
  }

  function isMqttConnected() {
    return Boolean(state.gatewaySnapshot?.mqtt?.connected);
  }

  function isSystemConnected() {
    return isGatewayConnected() && isMqttConnected();
  }

  function isOrderLocked() {
    return state.order.status !== "idle";
  }

  function factoryReady() {
    const factory = state.order.factory;
    return Boolean(factory?.received && factory.valid && !factory.stale && factory.state === "WAITING_FOR_ORDER");
  }

  function factoryBlock() {
    const factory = state.order.factory;
    if (!factory?.received) return { code: "FACTORY_STATE_UNKNOWN", message: "Aguardando o estado da fábrica." };
    if (!factory.valid) return { code: "FACTORY_STATE_INVALID", message: "O estado recebido da fábrica é inválido." };
    if (factory.stale) return { code: "FACTORY_STATE_REFRESH_REQUIRED", message: "Aguardando o estado atual da fábrica." };
    if (factory.state !== "WAITING_FOR_ORDER") return { code: "FACTORY_BUSY", message: `Fábrica em ${factory.state}.` };
    return null;
  }

  function selectedStockCount() {
    return Number(state.stock.counts?.[selectedPiece().type] || 0);
  }

  function requestBlock() {
    if (!isSystemConnected()) return { code: "DISCONNECTED", message: "Sem conexão com a fábrica." };
    if (state.gatewaySnapshot?.gateway?.commandsEnabled === false) {
      return { code: "FACTORY_COMMANDS_DISABLED", message: "Comandos físicos estão desabilitados neste gateway." };
    }
    if (isOrderLocked()) return { code: "ORDER_ALREADY_PENDING", message: "Aguarde a conclusão do pedido atual." };
    const currentFactoryBlock = factoryBlock();
    if (currentFactoryBlock) return currentFactoryBlock;
    if (!state.stock.received) return { code: "STOCK_UNKNOWN", message: "Aguardando estoque." };
    if (state.stock.stale) return { code: "STOCK_STALE", message: "O estoque está desatualizado." };
    if (!state.stock.valid || state.stock.inconsistent) return { code: "STOCK_INVALID", message: "O estoque recebido está inconsistente." };
    if (selectedStockCount() < 1) return { code: "OUT_OF_STOCK", message: "Sem estoque para a cor selecionada." };
    return null;
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
      connecting: ["CONECTANDO", "Localizando o gateway", "Conectando ao notebook intermediário…"],
      connected: ["CONECTADO", "Gateway e fábrica online", "Preparando interface…"],
      reconnecting: ["RECONECTANDO", "Restabelecendo comunicação", "A reconexão continuará automaticamente…"],
      offline: ["SEM CONEXÃO", "Gateway fora de alcance", "Verifique o servidor no notebook e a rede local."],
      error: ["SISTEMA INDISPONÍVEL", "Fábrica ainda não acessível", "Gateway encontrado, mas o MQTT da fábrica está offline."],
    };
    return presentations[state.connection.status] || presentations.connecting;
  }

  function formatElapsed(timestamp) {
    if (!timestamp) return "—";
    const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
    if (seconds < 1) return "agora";
    return `${seconds.toFixed(seconds < 10 ? 1 : 0).replace(".", ",")} s`;
  }

  function renderConnection() {
    const [pill, title, defaultDescription] = connectionPresentation();
    const diagnostics = gatewayDiagnostics();
    const description = state.connection.userMessage || state.connection.lastError?.message || defaultDescription;
    dom.connectionConsole.dataset.status = state.connection.status;
    dom.connectionPill.className = `status-pill is-${state.connection.status}`;
    dom.connectionPillText.textContent = pill;
    dom.connectionTitle.textContent = title;
    dom.connectionDescription.textContent = description;
    dom.connectionLive.textContent = `${pill}. ${description}`;
    dom.connectionConsole.classList.toggle("is-expanded", state.connection.detailsExpanded);
    dom.connectionDetails.setAttribute("aria-hidden", String(!state.connection.detailsExpanded));
    dom.detailsToggle.setAttribute("aria-expanded", String(state.connection.detailsExpanded));
    dom.detailsToggleLabel.textContent = state.connection.detailsExpanded ? "ocultar detalhes" : "detalhes da conexão";
    dom.detailsSecurityBadge.textContent = window.location.protocol === "https:" ? "HTTPS + WSS" : "HTTP + WS";
    dom.detailBroker.textContent = diagnostics.endpoint || "—";
    dom.detailBroker.title = diagnostics.endpoint || "";
    dom.detailClientId.textContent = diagnostics.mqttClientId || "—";
    dom.detailClientId.title = diagnostics.mqttClientId || "";
    dom.detailAttempt.textContent = String(diagnostics.attempt || state.connection.attempt || 0);
    dom.detailState.textContent = `${diagnostics.connected ? "WS online" : "WS offline"} / ${diagnostics.mqttConnected ? "MQTT online" : "MQTT offline"}`;
    dom.detailLastAttempt.textContent = formatElapsed(diagnostics.lastAttemptAt);
    dom.detailNextAttempt.textContent = diagnostics.mqttBrokerUrl || "—";
    dom.detailNextAttempt.title = diagnostics.mqttBrokerUrl || "";
    dom.detailOnline.textContent = navigator.onLine ? "online" : "offline";
    dom.detailPageProtocol.textContent = `${window.location.protocol} · ${diagnostics.mode || "modo desconhecido"}`;
    dom.detailLastError.textContent = state.connection.lastError?.message || state.gatewaySnapshot?.mqtt?.lastError?.message || "Nenhum erro registrado.";
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
      const outOfStock = state.stock.received && !state.stock.stale && Number(state.stock.counts?.[piece.type] || 0) < 1;
      card.classList.remove("position-left", "position-center", "position-right", "is-focus-target");
      card.classList.add(`position-${position}`);
      card.classList.toggle("is-out-of-stock", outOfStock);
      card.classList.toggle("is-focus-target", position === "center" && state.carousel.focusTarget === "card" && !isOrderLocked());
      const positionLabel = position === "center" ? "selecionada" : position === "left" ? "anterior" : "próxima";
      card.setAttribute("aria-label", `${piece.name.toLowerCase()}, ${positionLabel}, estoque ${state.stock.counts?.[piece.type] ?? "desconhecido"}`);
      card.setAttribute("aria-current", position === "center" ? "true" : "false");
      card.setAttribute("aria-disabled", String(isOrderLocked()));
    });
    const piece = selectedPiece();
    dom.selectedName.textContent = piece.name;
    dom.selectedType.textContent = piece.type;
  }

  function renderStock() {
    const isUnavailable = !state.stock.received || state.stock.stale || !state.stock.valid || state.stock.inconsistent;
    const count = selectedStockCount();
    const piece = selectedPiece();

    dom.selectedStockCount.textContent = isUnavailable ? "—" : String(count);
    dom.selectedStockCount.dataset.state = isUnavailable ? "unavailable" : count < 1 ? "empty" : "available";
    dom.selectedStockCount.setAttribute(
      "aria-label",
      isUnavailable
        ? `Estoque lógico da ${piece.name.toLowerCase()} indisponível`
        : `${count} ${count === 1 ? "unidade" : "unidades"} da ${piece.name.toLowerCase()} no estoque lógico`,
    );
    dom.selectedStockCount.title = isUnavailable
      ? "Estoque lógico indisponível"
      : `Estoque lógico (f/i/stock): ${count}`;
  }

  function orderFeedback() {
    const labels = {
      submitting: "Enviando pedido ao gateway…",
      awaiting_ordered: "Publicado uma vez · aguardando ORDERED",
      ordered: "PEDIDO RECEBIDO pela fábrica",
      in_process: "EM PRODUÇÃO",
      shipped: "PEDIDO CONCLUÍDO",
      awaiting_ready: "Concluído · aguardando WAITING_FOR_ORDER",
      uncertain: "ESTADO INCERTO · sem reenvio automático",
      error: state.order.pending?.error || "Erro no envio · sem reenvio automático",
    };
    if (labels[state.order.status]) return labels[state.order.status];
    if (state.gatewaySnapshot?.gateway?.commandsEnabled === false) return "Modo somente leitura";
    if (!factoryReady()) {
      const block = factoryBlock();
      return block?.code === "FACTORY_BUSY"
        ? `Fábrica: ${state.order.factory.state}`
        : "Aguardando estado da fábrica";
    }
    if (state.order.factory?.inferred) return "Pronta · verificada pelas estações";
    return "Fábrica pronta para receber pedido";
  }

  function buttonLabel(block) {
    const labels = {
      submitting: "ENVIANDO…",
      awaiting_ordered: "AGUARDANDO PEDIDO",
      ordered: "PEDIDO RECEBIDO",
      in_process: "EM PRODUÇÃO",
      shipped: "PEDIDO CONCLUÍDO",
      awaiting_ready: "AGUARDANDO PRONTO",
      uncertain: "ESTADO INCERTO",
      error: "ERRO NO ENVIO",
    };
    if (labels[state.order.status]) return labels[state.order.status];
    if (block?.code === "FACTORY_COMMANDS_DISABLED") return "SOMENTE LEITURA";
    if (block?.code === "OUT_OF_STOCK") return "SEM ESTOQUE";
    if (["STOCK_UNKNOWN", "STOCK_STALE", "STOCK_INVALID"].includes(block?.code)) return "ESTOQUE INDISPONÍVEL";
    if (block?.code === "FACTORY_BUSY") return "FÁBRICA OCUPADA";
    if (["FACTORY_STATE_UNKNOWN", "FACTORY_STATE_INVALID", "FACTORY_STATE_REFRESH_REQUIRED", "FACTORY_NOT_READY"].includes(block?.code)) {
      return "AGUARDANDO ESTADO";
    }
    if (block?.code === "DISCONNECTED") return "SEM CONEXÃO";
    return "REQUISITAR";
  }

  function renderOrder() {
    const block = requestBlock();
    const locked = isOrderLocked();
    const diagnostics = gatewayDiagnostics();
    const chipStatus = isSystemConnected() ? "connected" : diagnostics.connected ? "reconnecting" : "offline";
    const chipLabels = { connected: "ONLINE", reconnecting: "MQTT OFF", offline: "GATEWAY OFF" };
    dom.orderScreen.classList.toggle("is-in-progress", locked);
    dom.connectionChip.dataset.status = chipStatus;
    dom.connectionChipText.textContent = chipLabels[chipStatus];
    dom.orderButton.disabled = Boolean(block);
    dom.orderButton.setAttribute("aria-disabled", String(Boolean(block)));
    dom.orderButton.classList.toggle("is-focus-target", state.carousel.focusTarget === "order-button" && !block);
    dom.orderButton.textContent = buttonLabel(block);
    dom.factoryFeedback.textContent = orderFeedback();
    renderCarousel();
    renderStock();
    syncTabStops();
  }

  function renderModal() {
    dom.modalLayer.hidden = !state.confirmation.open;
    if (!state.confirmation.open) {
      dom.orderScreen.inert = false;
      return;
    }
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
    dom.orderButton.tabIndex = state.screen === "order" && state.carousel.focusTarget === "order-button" && !requestBlock() && !state.confirmation.open ? 0 : -1;
    dom.cancelButton.tabIndex = state.confirmation.open ? 0 : -1;
    dom.confirmButton.tabIndex = state.confirmation.open ? 0 : -1;
  }

  function focusOrderTarget() {
    window.setTimeout(() => {
      if (state.screen !== "order" || state.confirmation.open || isOrderLocked()) {
        dom.app.focus({ preventScroll: true });
        return;
      }
      const target = state.carousel.focusTarget === "card" ? dom.cards[state.carousel.selectedIndex] : dom.orderButton;
      if (target?.disabled) dom.cards[state.carousel.selectedIndex]?.focus({ preventScroll: true });
      else target?.focus({ preventScroll: true });
    }, 0);
  }

  function setFocusTarget(target, focus = true) {
    if (!['card', 'order-button'].includes(target) || isOrderLocked()) return;
    state.carousel.focusTarget = target;
    renderOrder();
    if (focus) focusOrderTarget();
  }

  function enterOrderScreenIfReady() {
    if (!state.connection.minimumHomeElapsed || !isSystemConnected()) return false;
    window.clearTimeout(homeTimer);
    state.screen = "order";
    state.connection.detailsExpanded = false;
    state.connection.userMessage = null;
    render();
    focusOrderTarget();
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
    if (state.screen !== "order" || state.carousel.animating || state.confirmation.open || isOrderLocked()) return false;
    state.carousel.animating = true;
    state.carousel.selectedIndex = (state.carousel.selectedIndex + step + pieces.length) % pieces.length;
    renderOrder();
    window.setTimeout(() => {
      state.carousel.animating = false;
      focusOrderTarget();
    }, CONFIG.interaction.carouselDurationMs);
    return true;
  }

  function openConfirmation(type = selectedPiece().type, opener = document.activeElement) {
    const block = requestBlock();
    if (block) {
      showToast(block.message, ["OUT_OF_STOCK", "STOCK_STALE", "STOCK_INVALID"].includes(block.code) ? "warning" : "error");
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
    if (focus) (action === "cancel" ? dom.cancelButton : dom.confirmButton).focus({ preventScroll: true });
  }

  async function confirmOrder() {
    if (!state.confirmation.open || state.confirmation.selectedAction !== "confirm") return false;
    const type = state.confirmation.type;
    const block = requestBlock();
    if (type !== selectedPiece().type || !CONFIG.order.validTypes.includes(type) || block) {
      closeConfirmation({ restoreFocus: false });
      showToast(block?.message || "Pedido inválido.", "error");
      return false;
    }
    const operation = ++requestGeneration;
    state.order.status = "submitting";
    closeConfirmation({ restoreFocus: false });
    renderOrder();
    try {
      const pending = await GatewayService.requestOrder(type);
      if (operation !== requestGeneration) return false;
      state.order.pending = pending;
      state.order.status = pending?.status || "awaiting_ordered";
      renderOrder();
      showToast("Pedido enviado uma única vez", "success");
      return true;
    } catch (error) {
      if (operation !== requestGeneration) return false;
      debugError("Falha ao solicitar pedido", error);
      await GatewayService.refresh().catch(() => null);
      const remote = GatewayService.getState()?.order;
      if (remote?.pending) {
        state.order = { ...state.order, ...remote, status: remote.status || remote.pending.status };
      } else {
        state.order.status = "idle";
        state.order.error = error.message;
      }
      renderOrder();
      showToast(error.message || "Não foi possível enviar o pedido.", "error");
      return false;
    }
  }

  function applyGatewaySnapshot(snapshot) {
    if (!snapshot) return;
    state.gatewaySnapshot = snapshot;
    if (snapshot.stock) state.stock = { ...state.stock, ...snapshot.stock };
    if (snapshot.order) {
      const nextStatus = snapshot.order.status || snapshot.order.pending?.status || "idle";
      if (previousRemoteOrderStatus !== "idle" && nextStatus === "idle" && snapshot.order.last) {
        showToast("Fábrica pronta para nova solicitação", "success");
        dom.orderLive.textContent = "Fábrica pronta para nova solicitação.";
      }
      previousRemoteOrderStatus = nextStatus;
      state.order = { ...state.order, ...snapshot.order, status: nextStatus };
    }

    if (isSystemConnected()) {
      state.connection.status = "connected";
      state.connection.hasConnected = true;
      state.connection.outageActive = false;
      state.connection.lastError = null;
      state.connection.userMessage = null;
      enterOrderScreenIfReady();
    } else if (isGatewayConnected()) {
      state.connection.status = "error";
      state.connection.userMessage = "Gateway online; aguardando conexão MQTT com a fábrica.";
      if (state.connection.hasConnected) handleConnectionLost(state.connection.userMessage);
    }
    render();
  }

  function handleConnectionLost(message = "Comunicação interrompida. Nenhum pedido será reenviado.") {
    requestGeneration += 1;
    state.connection.status = navigator.onLine ? "reconnecting" : "offline";
    state.connection.userMessage = message;
    if (!state.connection.hasConnected) {
      renderConnection();
      return;
    }
    if (state.connection.outageActive) {
      renderConnection();
      return;
    }
    state.connection.outageActive = true;
    if (state.confirmation.open) closeConfirmation({ restoreFocus: false });
    beginHomeCycle(message);
  }

  function toggleConnectionDetails() {
    if (state.screen !== "connection") return;
    state.connection.detailsExpanded = !state.connection.detailsExpanded;
    renderConnection();
  }

  function detectSwipe(deltaX, deltaY) {
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    if (Math.max(absX, absY) < CONFIG.interaction.swipeThresholdPx) return null;
    if (absX > absY) return deltaX > 0 ? "swipe-right" : "swipe-left";
    return deltaY > 0 ? "swipe-down" : "swipe-up";
  }

  function routeModalCommand(command) {
    if (command === "swipe-left" || command === "swipe-right") setModalAction(state.confirmation.selectedAction === "cancel" ? "confirm" : "cancel");
    else if (command === "swipe-down" || command === "cancel") closeConfirmation();
    else if (command === "enter") state.confirmation.selectedAction === "confirm" ? confirmOrder() : closeConfirmation();
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
      setModalAction(state.confirmation.selectedAction === "cancel" ? "confirm" : "cancel");
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
    state.navigation.pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, modal: state.confirmation.open };
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
    dom.brandLogos.forEach((logo) => logo.addEventListener("error", () => logo.closest(".brand-mark")?.classList.add("logo-failed")));
    dom.detailsToggle.addEventListener("click", () => clickAllowed() && toggleConnectionDetails());
    dom.previousButton.addEventListener("click", () => clickAllowed() && rotateCarousel(-1));
    dom.nextButton.addEventListener("click", () => clickAllowed() && rotateCarousel(1));
    dom.cards.forEach((card, index) => {
      card.addEventListener("click", () => {
        if (!clickAllowed() || isOrderLocked()) return;
        const position = cardPosition(index);
        if (position === "center") openConfirmation(card.dataset.cardType, card);
        else rotateCarousel(position === "left" ? -1 : 1);
      });
    });
    dom.orderButton.addEventListener("click", () => clickAllowed() && openConfirmation(selectedPiece().type, dom.orderButton));
    dom.cancelButton.addEventListener("focus", () => state.confirmation.open && setModalAction("cancel", false));
    dom.confirmButton.addEventListener("focus", () => state.confirmation.open && setModalAction("confirm", false));
    dom.cancelButton.addEventListener("click", () => clickAllowed() && closeConfirmation());
    dom.confirmButton.addEventListener("click", () => {
      if (!clickAllowed()) return;
      state.confirmation.selectedAction = "confirm";
      confirmOrder();
    });
    dom.app.addEventListener("pointerdown", handlePointerDown);
    dom.app.addEventListener("pointerup", handlePointerUp);
    dom.app.addEventListener("pointercancel", () => { state.navigation.pointerStart = null; });
    document.addEventListener("keydown", handleKeydown);
    document.addEventListener("focusin", (event) => {
      if (state.confirmation.open && !dom.confirmationDialog.contains(event.target)) {
        (state.confirmation.selectedAction === "cancel" ? dom.cancelButton : dom.confirmButton).focus({ preventScroll: true });
      }
    });
    window.addEventListener("offline", () => handleConnectionLost("O aparelho está sem acesso à rede. Nenhum pedido será reenviado."));
    window.addEventListener("online", () => GatewayService.reconnect());
  }

  function registerGatewayListeners() {
    GatewayService.on("attempt", (detail) => {
      state.connection.attempt = detail.attempt;
      state.connection.status = state.connection.hasConnected ? "reconnecting" : "connecting";
      renderConnection();
    });
    GatewayService.on("connect", (detail) => {
      applyGatewaySnapshot(detail.snapshot || GatewayService.getState());
    });
    GatewayService.on("state", (snapshot) => applyGatewaySnapshot(snapshot));
    GatewayService.on("offline", () => handleConnectionLost());
    GatewayService.on("error", (error) => {
      state.connection.lastError = error;
      state.connection.status = state.connection.hasConnected ? "reconnecting" : "offline";
      renderConnection();
    });
    GatewayService.on("integration-warning", (warning) => {
      debugWarn("Aviso de integração", warning);
      if (["MQTT_JSON_INVALID", "MQTT_SCHEMA_UNKNOWN", "RETAINED_ORDER_STATE_IGNORED", "INVALID_GATEWAY_EVENT"].includes(warning.code)) {
        showToast("Payload inesperado registrado no diagnóstico.", "warning");
      }
    });
  }

  function getDiagnostics() {
    return {
      ...GatewayService.getDiagnostics(),
      screen: state.screen,
      selectedType: selectedPiece().type,
      selectedStock: selectedStockCount(),
      orderStatus: state.order.status,
      factoryState: state.order.factory?.state || null,
      stock: state.stock,
    };
  }

  window.__FACTORY_DEMO__ = {
    CONFIG,
    GatewayService,
    getDiagnostics,
    reconnect: GatewayService.reconnect,
    state,
  };

  registerDomListeners();
  registerGatewayListeners();
  detailsTimer = window.setInterval(() => {
    if (state.screen === "connection" && state.connection.detailsExpanded) renderConnection();
    if (state.screen === "order") renderStock();
  }, 500);
  beginHomeCycle();
  render();
  GatewayService.connect();
})();
