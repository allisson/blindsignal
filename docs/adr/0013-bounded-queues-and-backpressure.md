# Bounded queues and backpressure

**Status:** accepted

Spec §8.4 requires bounded queues and backpressure without saying which queues or what happens
when one is full. A connection has two: the frames and events waiting to be handled, one at a
time and in arrival order, and the bytes waiting in its send buffer. Rate limits (ADR 0011) bound
neither: a rate-limited frame still waits its turn, events from other connections take no token,
and a client that stops reading grows the send buffer with replies it asked for. Both queues are
bounded per connection, and a full one closes the connection.

## Rules

- **Queued messages.** At most `BLINDSIGNAL_MAX_QUEUED_MESSAGES` frames and events (default
  1024) wait on one connection, the one being handled included. Timers that end a session or the
  connection count too; the release after the socket closes does not.
- **Backpressure.** Once half the queue is taken, the server stops reading the socket, so TCP
  slows the client down; it reads again when the queue drops below half. Frames already read and
  events keep arriving meanwhile, and fill the other half.
- **Buffered bytes.** When a send leaves more than `BLINDSIGNAL_MAX_BUFFERED_BYTES` (default
  1 MiB, at least one message of the protocol's maximum size) waiting to be written, the client is
  not reading.
- **A full queue or buffer closes the connection with `1013` (Try Again Later), without `error`**:
  the message would wait behind the backlog that caused the close. What was queued is dropped, and
  the connection releases its sessions and presence as after any close. The SDK reconnects with
  backoff, like after an abnormal closure.
- **A relayed message never closes its recipient** (amended by the Phase 12 abuse review). An
  `rtc.*` message for a connection whose send buffer holds more than half of
  `BLINDSIGNAL_MAX_BUFFERED_BYTES` is dropped and counted in
  `blindsignal_coordination_events_dropped_total{reason="overloaded"}`: a peer that floods its
  session loses its own negotiation, which the SDK's connection timeout ends (ADR 0018), instead
  of closing the other device's connection with `1013`. Size limits for `sdp` and `candidate`
  were considered and left out: sixteen sessions, each within its `rtc` bucket, would still fill
  the buffer.
- Each close is logged (`connection.overloaded`, with the limit reached) and counted
  (`blindsignal_overloaded_connections_total`). The defaults are starting values until load
  testing sets them (spec §8.2).

## Considered options

- **Drop the message and keep the connection.** Rejected: a dropped reply leaves a request
  pending, and a dropped `session.terminated` or `presence.changed` leaves the client's view of
  sessions and presence wrong, with no way to know.
- **Only pause reading.** Rejected: it bounds neither events from other connections nor a client
  that stops reading.
- **Close with an `error` code.** Rejected: it would wait behind the full send buffer, and a new
  code changes the catalog for a closure the SDK handles like any abnormal one.

## Consequences

- ADR 0011's flooding connection is answered only while its queue has room: a client that sends
  more than half the queue faster than the server reads it, in one burst, is closed. The SDK
  never does, since its own requests stay within the signaling bucket's burst.
- A connection stuck behind a slow adapter call pauses its client rather than buffering without
  limit; the queue's bound is per connection, so a process with many connections still needs the
  connection quotas (ADR 0011) to bound its memory.
