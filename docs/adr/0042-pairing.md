# Pairing by signed device approval

**Status:** accepted

Spec §7.4 asks for pairing: an explicit trust relationship between devices, authenticated, scoped
to an application and a namespace, approved by the backend or by an already authorized device,
revocable, and auditable. Namespace access comes only from the token (ADR 0007), and the backend
decides what goes in it, so pairing grants nothing on the server: it carries to the backend the
proof that an authorized device approved a new one. ADR 0041 gave every device a key to sign that
proof with.

## Rules

- **A `pairing` claim lets a device ask to be paired:** an array of namespace IDs, under the
  application's prefix, at most as many as `namespaces` allows; anything else rejects the token
  with `invalid_token`. It grants nothing else: no join, no discovery, no session.
- **Only a device whose token is bound to a key may ask, or approve** (ADR 0041). The approval
  binds the new device's key, and is signed by the approver's.
- **`pairing.create { namespace }` asks the user's own devices.** The server finds the devices of
  the same `sub` present in the namespace, other than the requester, and sends each
  `pairing.request { pairingId, namespace, userId, deviceId }`. None present: `peer_unavailable`.
  Inviting another user is the backend's business.
- **`pairing.approve` is a third permission of the `permissions` claim** (ADR 0040), with the same
  rule: a namespace the map does not list grants it. A device without it, or without a key, never
  receives the request; one whose refresh withdrew it gets `not_authorized` on `pairing.approve`.
- **The approval is a JWT the approver's device key signs:** header `typ`
  `blindsignal-pairing+jwt`, `alg` `ES256` or `EdDSA`, and `jwk`; claims `pairing_id`, `namespace`,
  `sub` and `device_id` of the new device, `jkt`, its key's thumbprint, and `exp`. The server
  checks the signature, that the thumbprint of `jwk` is the approving connection's `cnf.jkt`, and
  every claim against the request; anything else gets `invalid_message`, and the request stays open.
- **The first answer wins.** `pairing.approve` or `pairing.reject` gets `ack`; the requester gets
  `pairing.approved { pairingId, approval }` or `pairing.rejected { pairingId }`, and every other
  asked device `pairing.ended { pairingId, reason: "answered" }`. A later answer, or one to an
  unknown pairing, gets `pairing_unavailable`.
- **A request lasts the session negotiation timeout.** Each side ends its own copy with
  `pairing.ended` reason `timeout`; a requester that leaves ends the asked devices' copies with
  `requester_gone`.
- **The backend grants:** it checks the approval's signature against the key it bound to the
  approving device, its claims against the new device, and its `exp`, then issues tokens with the
  namespace. Revoking a pairing is leaving the namespace out of the next token, or revoking the
  device.
- **`pairing.create` takes a token from the `pairing` bucket,** per connection, which an
  application may override (ADR 0011).
- **The server stores no pairing.** Each connection keeps its copy in memory, and the copies stay
  in step through events on each connection's topic (ADR 0023). The requester's instance logs
  `pairing.requested`, `pairing.approved`, `pairing.rejected`, and `pairing.expired` with `appId`
  and `pairingId`, and counts `blindsignal_pairings_total{result}`.

## Considered options

- **Pairing only in the backend,** with no `pairing.*` message. Rejected: the new device and the
  approver would need a channel of their own, which is what BlindSignal provides.
- **Pairings stored by the server, granting namespaces,** with a `PairingRepository`. Rejected: it
  reverses ADR 0007, needs a migration, and makes the server a source of policy.
- **The requester names the approving device.** Rejected: a new device cannot discover its user's
  other devices without the backend.
- **Any user's device in the namespace may approve.** Rejected: a new device could reach every
  member, and inviting another user needs the backend's decision anyway.
- **The server relays the approval unread.** Rejected: an approver with a bug, or a malicious one,
  could send the new device anything.
- **`pairing.approve` denied unless listed.** Rejected: it would break the rule ADR 0040 set for the
  other permissions, while the backend checks every approval and the request reaches only the
  user's own devices.

## Consequences

- A device joins a namespace only with its backend's token, as before; pairing adds a way for that
  backend to learn that the user approved it on a device it trusts.
- Both devices need proof-of-possession, and so the SDK's `DeviceKey`.
- An answer sent while the requester's copy has already timed out, and the asked device's has not,
  gets `ack` and reaches no one; the requester has already received `timeout`.
- The SDK side, answering and asking for pairing, lands apart from the server side.
