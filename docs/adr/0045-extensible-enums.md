# Extensible enums

**Status:** accepted

Within a protocol major version, `docs/protocol.md` §2 allows adding an optional payload field and
a server-to-client message type that a client may ignore. Roadmap Phase 12 asks for a review of
that promise before a stable release, and the review found both kept by the code: every payload
schema strips the keys it does not know, at every depth, and the SDK drops a message whose type it
does not know.

Three server-sent fields were closed lists, though: `error.code`, `session.terminated.reason`,
and `pairing.ended.reason`. A value outside the list failed the whole message, and the SDK dropped
it. A request answered with an `error` of a new code, on a connection that stays open, never
settled, since only a closing connection rejects the pending requests; a session terminated with
a new reason stayed open on the client. Under ADR 0044, a new value would need a new protocol
major, kept next to the old one for at least 6 months. Tolerance helps only the SDKs that ship
with it, and none is published yet.

## Rules

- **Receivers accept any non-empty value in `error.code`, `session.terminated.reason`, and
  `pairing.ended.reason`.** The `protocol` package types each as the listed values or any other
  string (`Extensible`), so senders still name a listed value through their own types:
  `ErrorCode`, `TerminationReason`, and `PairingEndReason`.
- **A later release of the same protocol major may add a value to these three lists.** Removing a
  value or changing its meaning still needs the next major.
- **The SDK handles a value it does not list:**
  - an error code rejects the request with that code, as a retryable failure, and a closing
    connection is handled by its close code, which carries the class (§9);
  - a termination reason ends the session with that reason, and closes its DataChannel;
  - a pairing end reason ends the request: the device that asked gets `{ status: "timeout" }`,
    an asked device the `pairingEnded` event with that reason.
- **The server keeps the lists closed for what it receives:** no client-sent message carries one
  of these fields.

## Considered options

- **Closed lists, each new value a new protocol major.** Rejected: a single error code would cost
  a protocol major and its 6 months of overlap (ADR 0044).
- **Mapping an unknown value to a fixed one, such as `server_error`.** Rejected: the application
  would lose the code it could log or show, and a retryable mapping of a code sent with a terminal
  close would contradict the close code.
- **Every enum open, `rtc.ice_config` and identifiers included.** Rejected: only these three are
  lists the server can grow, and the others are formats a receiver must check.

## Consequences

- `BlindSignalError['code']` and the session end reason widen to any string, which the SDK's
  `0.x` versioning allows before its first publication (ADR 0043).
- The `protocol` package no longer exports `errorCodes`: nothing parses against the list.
- A test in `packages/protocol` parses every server-sent type with an unknown field in every
  object, and fails when a server-sent type is added without a sample, so the promise of §2 is
  checked for each new message.
