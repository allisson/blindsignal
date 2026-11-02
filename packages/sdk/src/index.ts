// Applications depend only on the SDK, which re-exports the protocol values it surfaces (ADR 0002).
export {
  errorClasses,
  terminationReasons,
  type ErrorClass,
  type ErrorCode,
} from '@blindsignal/protocol';
export { BlindSignalError } from './errors.ts';
export {
  BlindSignalClient,
  type BlindSignalClientOptions,
  type ClientEvents,
  type ConnectionState,
  type HeartbeatOptions,
  type Identity,
} from './client.ts';
export type { BackoffOptions } from './backoff.ts';
