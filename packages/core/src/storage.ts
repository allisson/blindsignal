import type { ApplicationRecord, DeviceIdentity, DeviceRecord } from './records.ts';

/** Durable metadata (spec §10.1, ADR 0010). Every method is asynchronous. */
export interface StorageAdapter {
  readonly applications: ApplicationRepository;
  readonly devices: DeviceRepository;
}

export interface ApplicationRepository {
  /** Replaces the whole registry atomically: readers never see a partial one. */
  replaceAll(applications: readonly ApplicationRecord[]): Promise<void>;
  /**
   * Replaces the registry with what `next` returns for the stored one, or keeps it when `next`
   * returns `undefined`. Calls on every instance take turns, so each decides on what the previous
   * one stored (ADR 0025).
   */
  replaceWith(
    next: (stored: readonly ApplicationRecord[]) => readonly ApplicationRecord[] | undefined,
  ): Promise<void>;
  getById(appId: string): Promise<ApplicationRecord | undefined>;
  getByIssuer(issuer: string): Promise<ApplicationRecord | undefined>;
  /** Every application, in no particular order. */
  getAll(): Promise<readonly ApplicationRecord[]>;
}

export type DeviceTouchResult =
  | { readonly ok: true; readonly record: DeviceRecord }
  | { readonly ok: false; readonly reason: 'quota_exceeded' };

export interface DeviceLimits {
  readonly maxDevices: number;
  readonly maxDevicesPerUser: number;
  readonly ttlMs: number;
}

export interface DeviceRepository {
  /**
   * Creates the record or updates `lastAuthenticatedAt`, in one atomic call. A new record is
   * refused when the application already has `maxDevices` live records, or its user
   * `maxDevicesPerUser`; records not touched within `ttlMs` are expired and do not count.
   */
  touch(device: DeviceIdentity, now: Date, limits: DeviceLimits): Promise<DeviceTouchResult>;
  /** Deletes every record not touched within `ttlMs`; returns how many (ADR 0012). */
  deleteExpired(now: Date, ttlMs: number): Promise<number>;
}
