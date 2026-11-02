import type {
  ApplicationRecord,
  ApplicationRepository,
  DeviceIdentity,
  DeviceRecord,
  DeviceRepository,
  DeviceTouchResult,
} from '@blindsignal/core';

/** Single-instance only: state lives in this process (spec §10.3). */
export class InMemoryApplicationRepository implements ApplicationRepository {
  #byId = new Map<string, ApplicationRecord>();
  #byIssuer = new Map<string, ApplicationRecord>();

  replaceAll(applications: readonly ApplicationRecord[]): Promise<void> {
    // Both maps are built first and swapped together, so readers never see a partial registry.
    this.#byId = new Map(applications.map((app) => [app.appId, app]));
    this.#byIssuer = new Map(applications.map((app) => [app.issuer, app]));
    return Promise.resolve();
  }

  getById(appId: string): Promise<ApplicationRecord | undefined> {
    return Promise.resolve(this.#byId.get(appId));
  }

  getByIssuer(issuer: string): Promise<ApplicationRecord | undefined> {
    return Promise.resolve(this.#byIssuer.get(issuer));
  }
}

/** Single-instance only: state lives in this process and is lost on restart (ADR 0010). */
export class InMemoryDeviceRepository implements DeviceRepository {
  /** Records per application, keyed by `(userId, deviceId)`. */
  readonly #byApp = new Map<string, Map<string, DeviceRecord>>();

  touch(
    device: DeviceIdentity,
    now: Date,
    { maxDevices, ttlMs }: { readonly maxDevices: number; readonly ttlMs: number },
  ): Promise<DeviceTouchResult> {
    const { appId, userId, deviceId } = device;
    let records = this.#byApp.get(appId);
    if (records === undefined) this.#byApp.set(appId, (records = new Map<string, DeviceRecord>()));
    const key = JSON.stringify([userId, deviceId]);
    const isLive = (record: DeviceRecord) =>
      now.getTime() - record.lastAuthenticatedAt.getTime() < ttlMs;

    const existing = records.get(key);
    if (existing !== undefined && isLive(existing)) {
      const record = { ...existing, lastAuthenticatedAt: now };
      records.set(key, record);
      return Promise.resolve({ ok: true, record });
    }
    // A new device: expired records are dropped first, so they never count toward the quota.
    for (const [other, record] of records) if (!isLive(record)) records.delete(other);
    if (records.size >= maxDevices) return Promise.resolve({ ok: false, reason: 'quota_exceeded' });
    const record = { appId, userId, deviceId, firstSeenAt: now, lastAuthenticatedAt: now };
    records.set(key, record);
    return Promise.resolve({ ok: true, record });
  }
}
