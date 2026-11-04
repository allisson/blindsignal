# Graceful shutdown

**Status:** accepted

On `SIGTERM` the server fails readiness, refuses new upgrades with HTTP `503`, closes every
connection with `1001`, and exits once each connection has released its sessions and presence
(ADR 0028). Two gaps remained before deploying it behind a load balancer or a platform:

- **Readiness failed in the same instant the connections closed.** A load balancer that checks
  readiness every few seconds kept routing reconnects to the instance for that long, and each got
  `503` and backed off again.
- **Nothing bounded the shutdown.** A client that never answers the close frame holds its socket
  for `ws`'s 30-second close timeout, and a release that waits on an unreachable Redis holds it
  longer. Platforms kill the process after a grace period, 10 seconds on Cloud Run and in
  `docker stop`, so the last steps, closing storage and coordination, never ran.

## Rules

- **`BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS` delays the closures;** 0, the default, closes at once.
  Readiness fails and upgrades get `503` from the signal on, while the open connections keep
  working until the delay ends. Behind a load balancer that polls `/readyz`, set it to the time the
  load balancer takes to stop routing to a failing instance; Cloud Run stops routing on the signal
  itself, so it needs none.
- **`BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS` bounds the whole shutdown, the delay included;**
  default 8, below the 10-second grace period of Cloud Run and `docker stop`, and it must exceed
  the delay. When it runs out, the server logs `server.shutdown_timeout` and exits with status 1;
  what the connections did not release expires with its lease (ADR 0022, ADR 0026).
- **A shutdown that completes exits with status 0,** as before.
- **`BLINDSIGNAL_STARTUP_TIMEOUT_SECONDS` bounds the startup;** default 30 (amended with the
  operator robustness fixes). A server that is not listening by then, such as one waiting on an
  unreachable Redis or a database that never answers, logs `server.start_failed` with reason
  `startup timed out` and exits with status 1, so the platform restarts it instead of keeping an
  instance that never becomes ready.

## Considered options

- **Accepting upgrades during the delay.** Rejected: each would be closed with `1001` moments
  later, adding an authentication and a `jti` claim, while a `503` sends the client to another
  instance through its backoff.
- **Spreading the closures over the delay,** as the maximum lifetime does (ADR 0029). Rejected for
  now: the SDK's backoff already spreads the reconnects, and an instance stopping with thousands of
  connections can raise the delay.
- **No default timeout.** Rejected: a shutdown cut by the platform's `SIGKILL` leaves no log line,
  and the timeout costs nothing when the shutdown finishes in time.

## Consequences

- The delay and the timeout must fit the platform's grace period: Kubernetes' default of 30
  seconds fits a delay of 5 and a timeout of 25; `terminationGracePeriodSeconds` and
  `docker stop --time` raise it.
- A shutdown that times out still leaves the instance's presence and slots in Redis until their
  lease expires, as an instance failure does.
