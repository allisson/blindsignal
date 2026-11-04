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
  /** How long a session may stay active; 0 sets no limit (ADR 0014). */
  readonly sessionDurationSeconds: number;
  /** The user's present devices that one pairing request reaches (ADR 0042). */
  readonly pairingApprovers: number;
}

export interface RateLimitPolicy {
  readonly ratePerSecond: number;
  readonly burst: number;
}

/** Rate-limit categories keyed after authentication, so an application can override them. */
export type ApplicationRateLimit =
  | 'discovery'
  | 'session_create'
  | 'pairing'
  | 'presence'
  | 'signaling'
  | 'rtc'
  | 'rtc_ice_candidate';

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
  /** Rejects tokens not bound to a device key with `cnf.jkt` (ADR 0041). */
  readonly requireProofOfPossession?: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One per device; expires after a period without authentication (ADR 0010). */
export interface DeviceRecord extends DeviceIdentity {
  readonly firstSeenAt: Date;
  readonly lastAuthenticatedAt: Date;
}

/** Permissions a token may restrict per namespace (ADR 0040, ADR 0042). */
export type Permission = 'session.create' | 'session.accept' | 'pairing.approve';

/** What an authenticated connection is, replaced whole on every successful `auth.refresh`. */
export interface ConnectionContext extends DeviceIdentity {
  /** The current token's `namespaces` claim (ADR 0007). */
  readonly namespaces: readonly string[];
  /**
   * The current token's `permissions` claim: a listed namespace grants only its permissions, an
   * unlisted one grants both (ADR 0040).
   */
  readonly permissions?: Readonly<Record<string, readonly Permission[]>>;
  /** The current token's `pairing` claim: namespaces it may ask to be paired into (ADR 0042). */
  readonly pairing?: readonly string[];
  /** The current token's `cnf.jkt`: the device key it is bound to, kept on refresh (ADR 0041). */
  readonly keyThumbprint?: string;
  readonly tokenExpiresAt: Date;
  readonly protocolVersion: number;
}
