// Applications depend only on the SDK, which re-exports the protocol values it surfaces (ADR 0002).
export {
  errorClasses,
  terminationReasons,
  type ErrorClass,
  type ErrorCode,
} from '@blindsignal/protocol';
export { BlindSignalError } from './errors.ts';
