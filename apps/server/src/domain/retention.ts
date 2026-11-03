import type { DeviceRepository } from '@blindsignal/core';
import type { Logger } from '../telemetry.ts';

/**
 * Deletes expired device records every `intervalMs` (ADR 0012, ADR 0021). Every instance runs
 * it; a failure is logged and the next sweep tries again. Returns a function that stops it.
 */
export function sweepDevices(
  devices: Pick<DeviceRepository, 'deleteExpired'>,
  { intervalMs, ttlMs }: { readonly intervalMs: number; readonly ttlMs: number },
  logger: Logger,
): () => void {
  const timer = setInterval(() => {
    devices.deleteExpired(new Date(), ttlMs).then(
      (deleted) => {
        if (deleted > 0) logger.log('info', 'devices.expired', { deleted });
      },
      () => logger.log('warn', 'devices.sweep_failed'),
    );
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
