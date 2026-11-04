import {
  appId,
  deviceId,
  messages,
  namespaceId,
  pairingEndReasons,
  sessionId,
  terminationReasons,
  userId,
} from '@blindsignal/protocol';
import { z } from 'zod';

// Events between connections, on any instance, are parsed like client frames: an event that does
// not match is dropped, whatever published it (ADR 0023).

const connectionId = z.string().min(1).max(128);
const participant = z.object({
  connectionId,
  device: z.object({ appId, userId, deviceId }),
});
/** The connection that published the event, checked against the receiver's copy. */
const from = { from: connectionId };

/** Only `rtc.*` crosses between connections; its payload is rebuilt from the schema. */
const relayed = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rtc.offer'), payload: messages['rtc.offer'].payload }),
  z.object({ type: z.literal('rtc.answer'), payload: messages['rtc.answer'].payload }),
  z.object({
    type: z.literal('rtc.ice_candidate'),
    payload: messages['rtc.ice_candidate'].payload,
  }),
]);

export const connectionEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('superseded'), ...from }),
  z.object({ type: z.literal('deliver'), ...from, message: relayed }),
  z.object({
    type: z.literal('session.request'),
    ...from,
    session: z.object({
      id: sessionId,
      namespace: namespaceId,
      requester: participant,
      target: participant,
    }),
  }),
  z.object({ type: z.literal('session.accepted'), ...from, sessionId }),
  z.object({ type: z.literal('session.rejected'), ...from, sessionId }),
  z.object({
    type: z.literal('session.terminated'),
    ...from,
    sessionId,
    reason: z.enum(terminationReasons),
  }),
  z.object({
    type: z.literal('pairing.request'),
    ...from,
    pairing: z.object({
      id: sessionId,
      namespace: namespaceId,
      requester: participant,
      keyThumbprint: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal('pairing.approved'),
    ...from,
    pairingId: sessionId,
    approval: z.string().min(1),
  }),
  z.object({ type: z.literal('pairing.rejected'), ...from, pairingId: sessionId }),
  z.object({
    type: z.literal('pairing.ended'),
    ...from,
    pairingId: sessionId,
    reason: z.enum(pairingEndReasons),
  }),
]);

export type ConnectionEvent = z.infer<typeof connectionEvent>;

export const presenceEvent = messages['presence.changed'].payload;
