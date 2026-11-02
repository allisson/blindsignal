/** A device is identified by the triple, never by `deviceId` alone (ADR 0006). */
export interface DeviceIdentity {
  readonly appId: string;
  /** The token's `sub`. */
  readonly userId: string;
  readonly deviceId: string;
}

export type ApplicationStatus = 'active' | 'suspended' | 'revoked';

export type SigningAlgorithm = 'EdDSA' | 'ES256';

export interface PublicJwk {
  readonly kid: string;
  readonly kty: string;
  readonly [parameter: string]: unknown;
}

/** Either a remote key set or static keys, never both (spec §5.3). */
export type IssuerKeys =
  { readonly jwksUri: string } | { readonly publicKeys: readonly PublicJwk[] };

/** Concurrency and count limits (ADR 0011). */
export interface Quotas {
  readonly connections: number;
  readonly devices: number;
  readonly sessions: number;
  readonly sessionsPerDevice: number;
  readonly namespacesPerDevice: number;
}

export interface RateLimitPolicy {
  readonly ratePerSecond: number;
  readonly burst: number;
}

/** Rate-limit categories keyed after authentication, so an application can override them. */
export type ApplicationRateLimit =
  'discovery' | 'session_create' | 'signaling' | 'rtc' | 'rtc_ice_candidate';

/** A registry entry (spec §5.1, ADR 0005). Limits it leaves out take the server defaults. */
export interface ApplicationRecord {
  readonly appId: string;
  readonly name: string;
  readonly status: ApplicationStatus;
  readonly issuer: string;
  readonly audience: string;
  readonly keys: IssuerKeys;
  readonly algorithms: readonly SigningAlgorithm[];
  readonly quotas: Partial<Quotas>;
  readonly rateLimits: Partial<Record<ApplicationRateLimit, RateLimitPolicy>>;
  readonly revokedDevices: readonly Omit<DeviceIdentity, 'appId'>[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One per device; expires after a period without authentication (ADR 0010). */
export interface DeviceRecord extends DeviceIdentity {
  readonly firstSeenAt: Date;
  readonly lastAuthenticatedAt: Date;
}

/** What an authenticated connection is, replaced whole on every successful `auth.refresh`. */
export interface ConnectionContext extends DeviceIdentity {
  /** The current token's `namespaces` claim (ADR 0007). */
  readonly namespaces: readonly string[];
  readonly tokenExpiresAt: Date;
  readonly protocolVersion: number;
}
