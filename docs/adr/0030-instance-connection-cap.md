# Connection cap per instance

**Status:** accepted

ADR 0011 caps unauthenticated connections per client IP and in all, and the quota of connections
per application is shared by every instance. Nothing bounded how many connections one instance
holds, so a burst of authenticated clients could exhaust its memory or file descriptors. Hosting
platforms bound it from outside, such as Cloud Run's maximum concurrency per instance, at most
1000, and a server that refuses past its own cap fails cleanly instead.

## Rules

- **`BLINDSIGNAL_MAX_CONNECTIONS` caps the open connections of an instance;** 0, the default,
  sets none. A connection counts from the upgrade, once past the `Origin` check, until its socket
  closes, authenticated or not, so concurrent upgrades cannot all pass the cap.
- **An upgrade past the cap is refused with HTTP `503`,** with no `Retry-After`: a browser
  reports the refusal only as a failed open, and the SDK reconnects with backoff, reaching another
  instance or this one once a connection has closed.
- **Readiness does not change** when the instance is full (ADR 0028): a readiness that follows
  the cap flaps around it, and with every instance full it leaves the load balancer with none.
- Behind a platform with a concurrency limit, set the cap at or below it, so the platform starts
  another instance before this one refuses.

## Considered options

- **Failing readiness while full.** Rejected: the flapping and the empty load balancer above.
- **Capping authenticated connections only,** closing the one past the cap with `1013` after
  `auth.authenticate`. Rejected: the instance has already accepted the upgrade and verified the
  token by then.
- **A default cap.** Rejected for now: the memory a connection holds was not measured, so any
  default would be a guess.

## Consequences

- With every instance full, new clients retry with backoff until a connection closes or the
  platform adds an instance.
- The unauthenticated caps of ADR 0011 still apply under this one.
