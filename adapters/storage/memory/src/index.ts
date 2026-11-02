import type { ApplicationRecord, ApplicationRepository } from '@blindsignal/core';

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
