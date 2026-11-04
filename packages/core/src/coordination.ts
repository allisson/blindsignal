import type { DeviceIdentity, RateLimitPolicy } from './records.ts';

export type RateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number };

export interface Slot {
  readonly key: string;
  readonly limit: number;
}

/**
 * Ephemeral state and event delivery (spec §10.2, ADR 0010). Every operation is atomic and
 * asynchronous. Operations that release take the holder, so a stale holder cannot release
 * what a newer one owns.
 */
export interface CoordinationAdapter {
  /** Records `(issuer, jti)` for `ttlMs`; true when the pair was new (ADR 0006). */
  claimJti(issuer: string, jti: string, ttlMs: number): Promise<boolean>;

  /**
   * Makes the connection the device's only one for `ttlMs`; returns the live claim it replaced
   * (ADR 0008). A claim not renewed expires, so a lost instance leaves none held (ADR 0022).
   */
  claimDeviceConnection(
    device: DeviceIdentity,
    connectionId: string,
    ttlMs: number,
  ): Promise<string | undefined>;
  /**
   * Extends the claim for `ttlMs` while `connectionId` holds it, or takes it again once it expired;
   * false, changing nothing, when another connection holds it.
   */
  renewDeviceConnection(
    device: DeviceIdentity,
    connectionId: string,
    ttlMs: number,
  ): Promise<boolean>;
  /** Removes the claim only while `connectionId` still holds it. */
  releaseDeviceConnection(device: DeviceIdentity, connectionId: string): Promise<void>;
  /** The connection that holds the device's live claim, on any instance (ADR 0023). */
  connectionOf(device: DeviceIdentity): Promise<string | undefined>;

  /** Acquires or renews the device's lease in the namespace for `ttlMs`. */
  acquirePresence(
    namespace: string,
    device: DeviceIdentity,
    connectionId: string,
    ttlMs: number,
  ): Promise<void>;
  /** Removes the lease only while `connectionId` still holds it; true when it did. */
  releasePresence(
    namespace: string,
    device: DeviceIdentity,
    connectionId: string,
  ): Promise<boolean>;
  /** Devices with a live lease in the namespace. */
  listPresence(namespace: string): Promise<readonly DeviceIdentity[]>;

  /** Takes one token from the key's bucket. */
  consumeRateLimit(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision>;

  /**
   * Takes one slot under each key's limit for `holder` for `ttlMs`, all or none: a session takes
   * the application's and both devices' slots together (ADR 0011). True when all were free.
   * Acquiring again renews the holder's slots; a slot not renewed expires, so a lost instance
   * leaves no slot held (ADR 0022).
   */
  acquireSlots(holder: string, slots: readonly Slot[], ttlMs: number): Promise<boolean>;
  /** Releases `holder`'s slots under these keys; releasing twice has no effect. */
  releaseSlots(holder: string, keys: readonly string[]): Promise<void>;

  /**
   * Delivers an event to every subscriber of the topic, on any instance, at most once. Events are
   * JSON values: a subscriber receives a copy (ADR 0022).
   */
  publish(topic: string, event: unknown): Promise<void>;
  /** Resolves once subscribed, to a function that unsubscribes. */
  subscribe(topic: string, handler: (event: unknown) => void): Promise<() => Promise<void>>;
}
