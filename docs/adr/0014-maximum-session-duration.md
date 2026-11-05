# Maximum session duration

**Status:** accepted

Spec §8.2 lists a maximum session duration, "where required", among the application quotas. ADR
0011 left it out, since a session already ends with either connection (ADR 0004). An application
may still want to bound how long one session lasts, for example to cap a call. The server enforces
an optional maximum on active sessions and ends them with the existing `timeout` reason.

## Rules

- **Optional, per application.** `BLINDSIGNAL_MAX_SESSION_DURATION_SECONDS` is the server default,
  `0` (no limit); an application's registry entry sets its own under
  `quotas.sessionDurationSeconds` (ADR 0005), a positive number of seconds.
- **Counted from `session.accept`.** A pending session is already bounded by the negotiation
  timeout. The duration comes from the requester's limits, read at its last authentication or
  refresh, and travels to the target in the `session.request` event, so both copies end together
  (amended by the Phase 12 abuse review: each side used its own limits, which a refresh after a
  registry reload could set apart). An event from an instance of the previous minor version
  carries none, and the target uses its own.
- **Ends with `session.terminated` reason `timeout`, sent to both participants,** like the
  negotiation timeout. The session's quota slots are freed.
- **Enforced through the SDK.** The server cannot sever a DataChannel (spec §6.4). The SDK closes
  the DataChannel of a session ended with `timeout` (docs/protocol.md §10), so the limit holds for
  clients that use it; a modified client can keep its DataChannel open, and only a new session
  goes through the server again.

## Considered options

- **A new termination reason, such as `max_duration`.** Rejected: an SDK that does not know the
  reason rejects the message, so adding one breaks every deployed SDK, and `timeout` already makes
  the SDK close the DataChannel.
- **Counted from creation.** Rejected: the time spent pending, up to the negotiation timeout,
  would shorten the session by an amount the application does not control.

## Consequences

- ADR 0011's "No maximum session duration" no longer holds; the quota exists and is off by
  default.
- An application cannot tell a negotiation timeout from a duration timeout by the reason alone;
  the session's state when it ended (`pending` or `active`) tells them apart.
- A registry reload changes the duration of sessions created after the requester's next refresh,
  not of sessions already created.
