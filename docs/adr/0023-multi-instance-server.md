# Multi-instance server

**Status:** accepted

ADR 0022 added a Redis-compatible `CoordinationAdapter`. This ADR wires the server to it, so
several instances behind one load balancer serve one deployment: devices on different instances
discover each other, open sessions, and exchange `rtc.*` messages. ADR 0024 propagates registry
reloads between instances.

## Rules

- **Coordination is chosen by `BLINDSIGNAL_REDIS_URL`.** Unset, the server keeps the in-memory
  adapter, for a single instance. Set to a `redis://` or `rediss://` URL, it opens two
  connections, one for commands and one for subscriptions, logs `coordination.ready` with the
  coordination it uses, and closes them on shutdown, after the connections are released. The
  server refuses `BLINDSIGNAL_REDIS_URL` without `BLINDSIGNAL_DATABASE_URL`: with device records
  in each instance's memory, the device quota and device revocation would hold per instance.
- **A Redis outage fails operations at once.** The client's offline queue is off, so an operation
  attempted while Redis is unreachable rejects, and the connection that attempted it closes with
  `server_error` (ADR 0021). Each failed reconnection logs `coordination.connection_lost`; the
  client reconnects with backoff and resubscribes its topics. Events published meanwhile are lost
  (ADR 0022). An upgrade, whose rate limit needs Redis, is dropped; the SDK reconnects with
  backoff. At startup the server waits for Redis and listens only once both connections are up.
- **The target's connection is found through coordination.** `CoordinationAdapter.connectionOf`
  reads the device's claim (ADR 0008), on any instance; the process no longer keeps its own map of
  devices to connections.
- **Each participant's connection keeps its own copy of a session.** The requester's connection
  creates its copy and sends the target's connection a `session.request` event with the
  session; the target's connection creates its own. Accepting, rejecting, and ending a session
  update the sender's copy first, then send `session.accepted`, `session.rejected`, or
  `session.terminated` to the other connection's topic, which updates its copy and tells its
  client. `rtc.*` is checked against the sender's copy, with no round trip to Redis.
- **Both copies time out.** Each arms the negotiation timeout and, once active, the maximum
  session duration (ADR 0014), so a copy whose peer's instance is gone still ends, and stops
  renewing its quota slots (ADR 0022). Both copies release the session's slots; releasing twice is
  harmless.
- **An event for a copy that no longer exists is dropped.** When the two sides end a session at
  once, such as a timeout racing a `session.reject`, each ends its own copy once and drops the
  other's late event: the requester may get `session.terminated` with reason `timeout` while the
  target's reject is acknowledged.
- **The requester's connection accounts for the session:** `blindsignal_sessions`,
  `blindsignal_application_sessions`, and the terminated counters count each session once, on the
  instance of the connection that requested it.

## Considered options

- **A shared session record in Redis,** with create, read, activate, and end operations. Rejected:
  every `rtc.ice_candidate` would read Redis, and the record would need its own expiry beside the
  slots.
- **A topic per device** to reach the target. Rejected: while a newer connection replaces an older
  one, both would receive the request.
- **Redis without PostgreSQL,** with a warning. Rejected: a quota or a revocation that holds on one
  instance only looks enforced and is not.
- **The client's offline queue.** Rejected: operations would hang until Redis returns, holding
  each connection's queue, instead of closing with a code the SDK retries.

## Consequences

- A session whose requester's instance stops ends on the target's side at its negotiation timeout
  or maximum duration; without a maximum duration, an active one lasts until the target's
  connection closes.
- Sessions are counted only by the requester's instance, so the per-instance gauges sum to the
  deployment's total.
- A registry reload reaches the other instances through ADR 0024.
