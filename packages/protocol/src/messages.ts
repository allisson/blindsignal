import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { deviceId, namespaceId, sessionId, userId } from './ids.ts';

export const PROTOCOL_VERSION = 1;

/** client: C→S; server: S→C; relay: C→S, rebuilt by the server for the other participant. */
export type Direction = 'client' | 'server' | 'relay';

interface MessageSpec {
  direction: Direction;
  payload: z.ZodObject;
  reply?: string;
}

const empty = z.object({});
// `proof` proves the device holds the key the token is bound to (ADR 0041).
const token = z.object({ token: z.string().min(1), proof: z.string().min(1).optional() });
const namespace = z.object({ namespace: namespaceId });
const session = z.object({ sessionId });
const device = { namespace: namespaceId, userId, deviceId };

export const terminationReasons = [
  'closed_by_peer',
  'peer_disconnected',
  'peer_revoked',
  'timeout',
  'namespace_unauthorized',
] as const;

// Message catalog, from docs/protocol.md §3 and §4. Unknown payload keys are stripped.
export const messages = {
  'auth.challenge': { direction: 'server', payload: z.object({ nonce: z.string().min(1) }) },
  'auth.authenticate': { direction: 'client', payload: token, reply: 'auth.result' },
  'auth.refresh': { direction: 'client', payload: token, reply: 'auth.result' },
  'auth.result': {
    direction: 'server',
    payload: z.object({ userId, deviceId, expiresInMs: z.int().nonnegative() }),
  },
  'namespace.join': { direction: 'client', payload: namespace, reply: 'ack' },
  'namespace.leave': { direction: 'client', payload: namespace, reply: 'ack' },
  'presence.changed': {
    direction: 'server',
    payload: z.object({ ...device, present: z.boolean() }),
  },
  'discovery.request': { direction: 'client', payload: namespace, reply: 'discovery.result' },
  'discovery.result': {
    direction: 'server',
    payload: z.object({ namespace: namespaceId, devices: z.array(z.object({ deviceId, userId })) }),
  },
  'session.create': { direction: 'client', payload: z.object(device), reply: 'session.created' },
  'session.created': { direction: 'server', payload: session },
  'session.request': { direction: 'server', payload: z.object({ sessionId, ...device }) },
  'session.accept': { direction: 'client', payload: session, reply: 'ack' },
  'session.reject': { direction: 'client', payload: session, reply: 'ack' },
  'session.accepted': { direction: 'server', payload: session },
  'session.rejected': { direction: 'server', payload: session },
  'session.close': { direction: 'client', payload: session, reply: 'ack' },
  'session.terminated': {
    direction: 'server',
    payload: z.object({ sessionId, reason: z.enum(terminationReasons) }),
  },
  'rtc.offer': { direction: 'relay', payload: z.object({ sessionId, sdp: z.string() }) },
  'rtc.answer': { direction: 'relay', payload: z.object({ sessionId, sdp: z.string() }) },
  'rtc.ice_candidate': {
    direction: 'relay',
    payload: z.object({ sessionId, candidate: z.string() }),
  },
  'rtc.ice_config': {
    direction: 'server',
    payload: z.object({
      iceServers: z.array(
        z.object({
          urls: z.array(z.string().min(1)).min(1),
          username: z.string().optional(),
          credential: z.string().optional(),
        }),
      ),
    }),
  },
  'connection.ping': { direction: 'client', payload: empty, reply: 'connection.pong' },
  'connection.pong': { direction: 'server', payload: empty },
  ack: { direction: 'server', payload: empty },
  error: {
    direction: 'server',
    payload: z.object({ code: z.enum(errorCodes), retryAfterMs: z.int().nonnegative().optional() }),
  },
} as const satisfies Record<string, MessageSpec>;

type Catalog = typeof messages;

export type MessageType = keyof Catalog;

export type Payload<T extends MessageType> = z.infer<Catalog[T]['payload']>;

export type Message<T extends MessageType = MessageType> = {
  [K in T]: {
    version: typeof PROTOCOL_VERSION;
    type: K;
    requestId?: string;
    payload: Payload<K>;
  };
}[T];

type TypesFrom<D extends Direction> = {
  [K in MessageType]: Catalog[K]['direction'] extends D ? K : never;
}[MessageType];

/** Sent by the client; every client-sent message carries a `requestId`. */
export type ClientMessage = Message<TypesFrom<'client' | 'relay'>> & { requestId: string };

/** Sent by the server: replies echo the `requestId`, events and relayed messages have none. */
export type ServerMessage = Message<TypesFrom<'server' | 'relay'>>;

export type RelayedMessage = Message<TypesFrom<'relay'>>;
