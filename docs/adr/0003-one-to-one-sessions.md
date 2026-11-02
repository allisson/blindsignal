# One-to-one sessions

**Status:** accepted

A session has exactly two participants: the device that requests it and the device that accepts
it. Multi-party sessions were rejected for the MVP: they need a topology (full mesh or otherwise),
an explicit target on every relayed `rtc.*` message, and the "maximum session participants" quota
(spec §8.2), and no MVP item requires them. An application that needs a group opens one session
per pair.

## Consequences

- Every relayed `rtc.*` message targets the other participant implicitly; it carries the session
  ID and no recipient.
- The "maximum session participants" quota is out of the MVP.
- Adding multi-party sessions later is a new major protocol version (`docs/protocol.md`).
