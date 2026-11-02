import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { ApplicationRecord } from '@blindsignal/core';
import { MAX_MESSAGE_BYTES } from '@blindsignal/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { clientIp, type ProxyTrust } from './domain/client-ip.ts';
import { isOriginAllowed, type AllowedOrigins } from './domain/origin.ts';
import { Connection, type ConnectionDependencies } from './handlers/connection.ts';

export interface SignalingServerOptions {
  readonly allowedOrigins: AllowedOrigins;
  /** Which forwarding headers to trust when deriving the client IP for logs (spec §8.1). */
  readonly proxyTrust: ProxyTrust;
  readonly heartbeatIntervalMs: number;
  readonly connection: ConnectionDependencies;
}

/** Close code for a server going away (RFC 6455), sent to every connection on shutdown. */
export const GOING_AWAY = 1001;

/**
 * The WebSocket transport on `node:http` (ADR 0001): the `Origin` check at the upgrade, ping
 * heartbeats, health and readiness, and graceful shutdown. Protocol state lives in `Connection`.
 */
export class SignalingServer {
  readonly #options: SignalingServerOptions;
  readonly #http = createServer((request, response) => this.#serveHttp(request, response));
  readonly #wss: WebSocketServer;
  readonly #connections = new Set<Connection>();
  readonly #alive = new WeakSet<WebSocket>();
  readonly #heartbeat: ReturnType<typeof setInterval>;
  /** Connections still releasing their sessions and presence after the socket closed. */
  readonly #releasing = new Set<Promise<void>>();
  #draining = false;

  constructor(options: SignalingServerOptions) {
    this.#options = options;
    const maxBytes = options.connection.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    // shortcut: frames up to twice the limit reach the parser, which answers message_too_large;
    // larger ones are cut by ws with 1009 before being buffered (docs/protocol.md §9).
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: 2 * maxBytes });
    this.#http.on('upgrade', (request, socket: Socket, head) =>
      this.#upgrade(request, socket, head),
    );
    this.#heartbeat = setInterval(() => this.#ping(), options.heartbeatIntervalMs);
  }

  /** Open WebSocket connections. */
  get connections(): number {
    return this.#connections.size;
  }

  /** Resolves to the bound port; port 0 picks a free one. */
  listen(port: number, host?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(port, host, () => {
        this.#http.off('error', reject);
        resolve((this.#http.address() as AddressInfo).port);
      });
    });
  }

  /**
   * Fails readiness, refuses new upgrades, and closes every connection with 1001, resolving once
   * each has released its sessions and presence.
   */
  async drain(): Promise<void> {
    this.#draining = true;
    const closing = [...this.#wss.clients].map(
      (ws) => new Promise<void>((resolve) => ws.once('close', () => resolve())),
    );
    for (const ws of this.#wss.clients) ws.close(GOING_AWAY);
    await Promise.all(closing);
    await Promise.all(this.#releasing);
  }

  /**
   * Applies a reloaded registry to the open connections, closing those whose application or
   * device is no longer available (ADR 0005).
   */
  async enforce(applications: readonly ApplicationRecord[]): Promise<void> {
    await Promise.all([...this.#connections].map((c) => c.enforce(applications)));
  }

  /** Stops listening and the heartbeat; call after `drain`. */
  close(): Promise<void> {
    clearInterval(this.#heartbeat);
    for (const ws of this.#wss.clients) ws.terminate();
    this.#wss.close();
    this.#http.closeAllConnections();
    return new Promise((resolve, reject) =>
      this.#http.close((error) => (error ? reject(error) : resolve())),
    );
  }

  #serveHttp(request: IncomingMessage, response: ServerResponse): void {
    const path = request.method === 'GET' ? request.url : undefined;
    const status =
      path === '/healthz' ? 200 : path === '/readyz' ? (this.#draining ? 503 : 200) : 404;
    response.writeHead(status, { 'content-type': 'text/plain' }).end(status === 200 ? 'ok' : '');
  }

  #upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    // Defense in depth only: non-browser clients send no Origin (spec §16).
    const refused = this.#draining
      ? 503
      : !isOriginAllowed(request.headers.origin, this.#options.allowedOrigins)
        ? 403
        : undefined;
    if (refused !== undefined) {
      socket.end(
        `HTTP/1.1 ${refused} ${refused === 403 ? 'Forbidden' : 'Service Unavailable'}\r\n\r\n`,
      );
      return;
    }
    const ip = clientIp(
      request.socket.remoteAddress ?? '',
      request.headers,
      this.#options.proxyTrust,
    );
    this.#wss.handleUpgrade(request, socket, head, (ws) => this.#accept(ws, ip));
  }

  #accept(ws: WebSocket, ip: string): void {
    const connection = new Connection(
      {
        send: (message) => ws.send(JSON.stringify(message)),
        close: (code) => ws.close(code),
      },
      this.#options.connection,
    );
    const { logger } = this.#options.connection;
    logger.log('info', 'connection.opened', { connectionId: connection.id, ip });
    this.#connections.add(connection);
    this.#alive.add(ws);
    // Protocol errors (oversized frame, invalid UTF-8) close the socket; 'close' releases.
    ws.on('error', () => {});
    // A binary frame is malformed (docs/protocol.md §9): the empty text fails as one.
    ws.on('message', (data, isBinary) => {
      void connection.receive(isBinary ? '' : (data as Buffer).toString('utf8'));
    });
    ws.on('pong', () => {
      this.#alive.add(ws);
      void connection.heartbeat();
    });
    ws.on('close', (code) => {
      this.#connections.delete(connection);
      logger.log('info', 'connection.closed', {
        connectionId: connection.id,
        appId: connection.context?.appId,
        code,
      });
      const released = connection.closed();
      this.#releasing.add(released);
      void released.finally(() => this.#releasing.delete(released));
    });
  }

  /** Terminates connections that missed the last ping; pings the rest (docs/protocol.md §8). */
  #ping(): void {
    for (const ws of this.#wss.clients) {
      if (!this.#alive.delete(ws)) {
        ws.terminate();
        continue;
      }
      ws.ping();
    }
  }
}
