# Load tests

**Status:** accepted

Spec §8.2 makes the quota and rate-limit defaults starting values until load testing validates
them, and Phase 12's acceptance criteria require that it does. Nothing defined what validating a
default means, which tool drives the load, or where the results go.

## Rules

- **A default is validated twice:**
  - **Headroom:** a legitimate workload stays under it, with no `rate_limited`, `quota_exceeded`,
    or HTTP `429`: a fleet that connects, joins, and discovers; a session's offer, answer, and
    candidates; and the whole fleet reconnecting after a restart, with the SDK's backoff.
  - **Capacity:** one instance holds the fleet that the per-application defaults admit, 10,000
    connections, and its memory, CPU, event loop delay, and latencies are measured.

  A measurement that contradicts a default changes the default, or the documentation says what
  it takes instead, such as more instances.
- **`tests/load/load.ts` drives the load:** a Node.js script on `ws` and `@blindsignal/dev-issuer`,
  with no dependency of its own. It starts the instances itself, one with the in-memory adapters,
  or two with PostgreSQL and Redis, and prints one JSON line per phase.
- **Each device sends its own client IP** in `X-Forwarded-For`, from a trusted loopback proxy, so
  the per-IP limits keep their defaults and each device has its own buckets (ADR 0011).
- **The load tests run before every minor and every major release,** as the security review does
  (ADR 0048), on both topologies, and `docs/load-report.md` records each run: the machine, the
  versions, the results, and what they changed.
- **CI runs `--smoke`,** 100 devices on one instance, which fails when a session does not
  complete, so the script keeps working; its numbers are not recorded.

## Considered options

- **k6 or Artillery.** Rejected: a tool outside ADR 0001, which speaks no BlindSignal protocol
  without a script of its own anyway.
- **Capacity only, connections and messages per second.** Rejected: it never shows whether a
  limit refuses a legitimate client, which is what a default must not do.
- **Raising the per-IP limits for the test,** as `examples/minimal-app` does. Rejected: those
  defaults would go unvalidated.
- **The full load in CI.** Rejected: shared runners give numbers too noisy to validate a default.

## Consequences

- The numbers hold for the machine of each run, client and server on one host; they bound a
  deployment's capacity only roughly, and the report says so.
- On one host, loopback has about 16,000 ephemeral ports per address: the fleet reconnects over
  IPv6 after the restart, and runs wait for the previous run's `TIME_WAIT` sockets to expire.
