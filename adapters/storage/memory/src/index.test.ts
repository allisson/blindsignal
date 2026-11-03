import { describeStorageContract } from '@blindsignal/core/testing';
import { InMemoryApplicationRepository, InMemoryDeviceRepository } from './index.ts';

describeStorageContract('in-memory storage', () =>
  Promise.resolve({
    applications: new InMemoryApplicationRepository(),
    devices: new InMemoryDeviceRepository(),
  }),
);
