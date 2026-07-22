"use strict";

const { WebSocketServer, WebSocket } = require("ws");

class EventHub {
  constructor({ getSnapshot, logger }) {
    this.getSnapshot = getSnapshot;
    this.logger = logger;
    this.server = new WebSocketServer({ noServer: true });
    this.server.on("connection", (socket, request) => {
      socket.isAlive = true;
      socket.on("pong", () => { socket.isAlive = true; });
      socket.on("error", (error) => this.logger.warn("warning", "Erro em cliente WebSocket", { error }));
      this.send(socket, "snapshot", this.getSnapshot(), { remoteAddress: request.socket.remoteAddress });
      this.broadcast("gateway-state", { websocketClients: this.clientCount });
    });
    this.heartbeat = setInterval(() => {
      for (const socket of this.server.clients) {
        if (!socket.isAlive) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }, 30000);
    this.heartbeat.unref?.();
  }

  get clientCount() {
    return this.server.clients.size;
  }

  handleUpgrade(request, socket, head) {
    let pathname;
    try {
      pathname = new URL(request.url, "http://gateway.local").pathname;
    } catch (_error) {
      socket.destroy();
      return false;
    }
    if (pathname !== "/events") {
      socket.destroy();
      return false;
    }
    this.server.handleUpgrade(request, socket, head, (client) => this.server.emit("connection", client, request));
    return true;
  }

  envelope(event, data) {
    return JSON.stringify({ event, data, sentAt: new Date().toISOString() });
  }

  send(socket, event, data) {
    if (socket.readyState === WebSocket.OPEN) socket.send(this.envelope(event, data));
  }

  broadcast(event, data) {
    const message = this.envelope(event, data);
    for (const socket of this.server.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }

  async close() {
    clearInterval(this.heartbeat);
    for (const socket of this.server.clients) socket.close(1001, "Gateway encerrando");
    await new Promise((resolve) => this.server.close(resolve));
  }
}

module.exports = { EventHub };
