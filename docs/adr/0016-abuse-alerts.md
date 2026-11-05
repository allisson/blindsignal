# Abuse alerts and operator-driven suspension

**Status:** accepted

Spec §8.3 asks for application suspension and operational alerts for abnormal usage. The roadmap
planned suspension triggered by abuse. Rate limits and quotas (ADR 0011) and bounded queues
(ADR 0013) already contain the abuse itself: what an operator still lacks is knowing that an
application keeps hitting them. The server raises an alert, and the operator decides whether to
suspend, through the registry (ADR 0005).

## Rules

- **The signal is an application's rejections:** `rate_limited` and `quota_exceeded` sent once
  the token is verified, the same errors `blindsignal_application_errors_total` counts
  (ADR 0015). Rejections before the token is verified have no application and stay with the
  pre-authentication limits, keyed by client IP.
- **Fixed windows per application.** When an application's rejections within one window reach
  `BLINDSIGNAL_ABUSE_ALERT_THRESHOLD`, the server logs `application.abuse_suspected` (`warn`, with
  the application ID, and the ID of the connection whose rejection reached the threshold, which
  `connection.opened` ties to a client IP; amended by the Phase 12 abuse review) and counts `blindsignal_abuse_alerts_total{app_id}`, once per window. The
  window is `BLINDSIGNAL_ABUSE_ALERT_WINDOW_SECONDS` (default 60). The threshold defaults to `0`,
  which turns alerts off, until load testing shows what normal usage looks like (spec §8.2).
- **Suspension stays with the operator:** `status: "suspended"` in the registry and `SIGHUP`,
  which rejects new authentication and closes the application's connections (Phase 3).
- **Prometheus can alert without the server's threshold,** on the ADR 0015 series, for example
  `increase(blindsignal_application_errors_total{code=~"rate_limited|quota_exceeded"}[5m]) > 100`.

## Considered options

- **Automatic suspension, temporary or until the operator lifts it.** Rejected: one abusive device
  would suspend every user of its application, a stronger denial of service than the abuse
  itself; the SDK treats `application_suspended` as terminal and would not reconnect after a
  temporary suspension, and a retryable code for it would change the catalog every deployed SDK
  validates; and a suspension held only in memory disagrees with the registry file, so the next
  reload or restart would undo it.
- **Documented Prometheus rules only.** Rejected as the only signal: an operator without
  Prometheus would get no alert. They remain an option above.

## Consequences

- The roadmap task becomes abuse alerts with operator-driven suspension; automatic suspension
  would need a new ADR, together with a retryable suspension code.
- Windows are per process: behind a load balancer, each instance counts its own share, so the
  threshold applies per instance until Phase 9 coordinates instances.
- The alert names one connection, the one whose rejection reached the threshold: the likeliest
  to be the one rejected most, not certainly it.
- Abuse by one device is answered by its rate limits and by device revocation (ADR 0005), not by
  suspending its application.
