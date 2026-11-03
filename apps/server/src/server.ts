import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { ApplicationRecord, CoordinationAdapter } from '@blindsignal/core';
import { MAX_MESSAGE_BYTES } from '@blindsignal/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PreAuthentication } from './config.ts';
import { clientIp, type ProxyTrust } from './domain/client-ip.ts';
import { isOriginAllowed, type AllowedOrigins } from './domain/origin.ts';
import { Connection, type ConnectionDependencies } from './handlers/connection.ts';

export interface SignalingServerOptions {
  readonly allowedOrigins: AllowedOrigins;
  /** Which forwarding headers to trust when deriving the client IP for logs (spec §8.1). */
  readonly proxyTrust: ProxyTrust;
  readonly heartbeatIntervalMs: number;
  /** Closes each connection with 1001 before this lifetime ends; 0 or absent for none (ADR 0029). */
  readonly maxConnectionMs?: number;
  /** Checked at the upgrade; the authentication deadline is the connection's. */
  readonly preAuthentication: Omit<PreAuthentication, 'authenticationTimeoutMs'>;
  readonly coordination: Pick<CoordinationAdapter, 'consumeRateLimit'>;
  readonly connection: ConnectionDependencies;
}

/** Close code for a server going away (RFC 6455), sent to every connection on shutdown. */
export const GOING_AWAY = 1001;

/**
 * When a connection with a maximum lifetime closes: between 90% and 100% of it, so connections
 * opened together do not all reconnect together (ADR 0029).
 */
export function connectionLifetime(maxMs: number, random: () => number = Math.random): number {
  return 0.9 * maxMs + 0.1 * maxMs * random();
}

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
  /** Unauthenticated connections per client IP, upgrades in progress included. */
  readonly #unauthenticated = new Map<string, number>();
  #unauthenticatedTotal = 0;

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

  /** Authenticated connections, by application (ADR 0015). */
  connectionsByApplication(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const { context } of this.#connections) {
      if (context !== undefined) counts.set(context.appId, (counts.get(context.appId) ?? 0) + 1);
    }
    return counts;
  }

  /** Sessions pending or active, counted by the instance of the connection that requested each. */
  sessionsByApplication(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const connection of this.#connections) {
      for (const { requester } of connection.requestedSessions) {
        const { appId } = requester.device;
        counts.set(appId, (counts.get(appId) ?? 0) + 1);
      }
    }
    return counts;
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
    if (this.#draining) return refuse(socket, 503);
    if (!isOriginAllowed(request.headers.origin, this.#options.allowedOrigins)) {
      return refuse(socket, 403);
    }
    const ip = clientIp(
      request.socket.remoteAddress ?? '',
      request.headers,
      this.#options.proxyTrust,
    );
    const { maxUnauthenticatedPerIp, maxUnauthenticated, connectionAttempts } =
      this.#options.preAuthentication;
    const fromIp = this.#unauthenticated.get(ip) ?? 0;
    if (fromIp >= maxUnauthenticatedPerIp || this.#unauthenticatedTotal >= maxUnauthenticated) {
      return refuse(socket, 429);
    }
    // Counted from now, so concurrent upgrades cannot all pass the cap; released once, when the
    // connection authenticates or the socket closes, whichever comes first.
    this.#unauthenticated.set(ip, fromIp + 1);
    this.#unauthenticatedTotal++;
    let counted = true;
    const authenticated = () => {
      if (!counted) return;
      counted = false;
      this.#unauthenticatedTotal--;
      const left = (this.#unauthenticated.get(ip) ?? 1) - 1;
      if (left === 0) this.#unauthenticated.delete(ip);
      else this.#unauthenticated.set(ip, left);
    };
    socket.once('close', authenticated);
    this.#options.coordination
      .consumeRateLimit(`connection_attempt:${ip}`, connectionAttempts)
      .then((decision) => {
        if (!decision.allowed) {
          return refuse(socket, 429, Math.ceil(decision.retryAfterMs / 1000));
        }
        this.#wss.handleUpgrade(request, socket, head, (ws) => this.#accept(ws, ip, authenticated));
      })
      .catch(() => socket.destroy());
  }

  #accept(ws: WebSocket, ip: string, authenticated: () => void): void {
    const connection = new Connection(
      {
        clientIp: ip,
        send: (message) => ws.send(JSON.stringify(message)),
        close: (code) => ws.close(code),
        authenticated,
        get bufferedBytes() {
          return ws.bufferedAmount;
        },
        pause: () => ws.pause(),
        resume: () => ws.resume(),
      },
      this.#options.connection,
    );
    const { logger } = this.#options.connection;
    logger.log('info', 'connection.opened', { connectionId: connection.id, ip });
    this.#connections.add(connection);
    this.#alive.add(ws);
    const { maxConnectionMs = 0 } = this.#options;
    const expiry =
      maxConnectionMs > 0
        ? setTimeout(() => ws.close(GOING_AWAY), connectionLifetime(maxConnectionMs))
        : undefined;
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
      clearTimeout(expiry);
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

const reasons = { 403: 'Forbidden', 429: 'Too Many Requests', 503: 'Service Unavailable' };

/** Answers an upgrade with an HTTP status and no WebSocket (ADR 0011). */
function refuse(socket: Socket, status: keyof typeof reasons, retryAfterSeconds?: number): void {
  const retryAfter = retryAfterSeconds === undefined ? '' : `Retry-After: ${retryAfterSeconds}\r\n`;
  socket.end(`HTTP/1.1 ${status} ${reasons[status]}\r\n${retryAfter}\r\n`);
}
