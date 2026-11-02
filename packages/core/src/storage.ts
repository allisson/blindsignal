import type { ApplicationRecord, DeviceIdentity, DeviceRecord } from './records.ts';

/** Durable metadata (spec §10.1, ADR 0010). Every method is asynchronous. */
export interface StorageAdapter {
  readonly applications: ApplicationRepository;
  readonly devices: DeviceRepository;
}

export interface ApplicationRepository {
  /** Replaces the whole registry atomically: readers never see a partial one. */
  replaceAll(applications: readonly ApplicationRecord[]): Promise<void>;
  getById(appId: string): Promise<ApplicationRecord | undefined>;
  getByIssuer(issuer: string): Promise<ApplicationRecord | undefined>;
}

export type DeviceTouchResult =
  | { readonly ok: true; readonly record: DeviceRecord }
  | { readonly ok: false; readonly reason: 'quota_exceeded' };

export interface DeviceRepository {
  /**
   * Creates the record or updates `lastAuthenticatedAt`, in one atomic call. A new record is
   * refused when the application already has `maxDevices` live records; records not touched
   * within `ttlMs` are expired and do not count.
   */
  touch(
    device: DeviceIdentity,
    now: Date,
    limits: { readonly maxDevices: number; readonly ttlMs: number },
  ): Promise<DeviceTouchResult>;
}
