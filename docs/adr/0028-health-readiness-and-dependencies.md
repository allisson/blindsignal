# Health, readiness, and dependency probes

**Status:** accepted

Phase 10 asks for meaningful health and readiness checks. `/healthz` answers 200 while the process
serves HTTP, and `/readyz` answers 503 once the server drains (`SIGTERM`); neither looks at
PostgreSQL or Redis. ADR 0021 rejected a `/readyz` that queries the database, because an outage
would take every instance out of the load balancer at once. Probing the dependencies from readiness
has a second failure: under load the pool is busy, the probe times out, the load balancer moves
the traffic to the other instances, and they saturate in turn.

## Rules

- **`/healthz` is liveness:** 200 while the process serves HTTP. It never depends on PostgreSQL or
  Redis, so an outage never makes an orchestrator restart healthy instances.
- **`/readyz` is readiness:** 200 once the server has started and until it drains, 503 while it
  drains. The server listens only after storage and coordination are open and the schema is
  checked (ADR 0019), so a ready instance has reached both at least once. It never probes them.
- **`/metrics` probes each configured dependency on every scrape:** `SELECT 1` through the
  PostgreSQL pool, and `PING` on the Redis command connection with the subscriber connection
  ready. `blindsignal_dependency_up{dependency="postgresql"|"redis"}` is 1 when the probe
  answers within `BLINDSIGNAL_DEPENDENCY_PROBE_TIMEOUT_SECONDS` (default 2), 0 otherwise. A
  dependency kept in memory has no series.
- **A probe still running is not started again:** the next scrape waits for the same one, so a
  dependency that hangs holds one query, not one per scrape.
- **An operator alerts on the gauge;** the server changes no routing on its own. With storage
  unreachable, authentications still fail with `server_error` (ADR 0021).

## Considered options

- **`/readyz` probing the dependencies on every request.** Rejected: the outage and the cascade
  above. It helps only an instance cut off from a dependency that the others still reach.
- **The same probe after N consecutive failures.** Rejected: it reduces flapping under load but
  keeps the outage case and adds state and a setting.
- **Only the clients' own state,** such as the Redis client's `isReady`. Rejected: the
  PostgreSQL pool exposes none, and it is the dependency the registry and devices live in.

## Consequences

- An instance cut off from a dependency stays in the load balancer; its clients get
  `server_error` and reconnect with backoff, reaching another instance or the same one. The
  dependency gauge of that instance shows 0.
- Every scrape costs one query and one `PING` per instance, and while PostgreSQL is saturated a
  probe waits in the pool's queue like any query.
