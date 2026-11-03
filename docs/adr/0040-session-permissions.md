# Session permissions from token claims

**Status:** accepted

Spec §7.2 lists `session.create` and `session.accept` as permissions of their own, and the MVP
enforced neither beyond namespace authorization (ADR 0007): any device in a namespace could
request a session with any other, and accept one from any other. An application could not let a
device be reached without letting it reach others, or the reverse, such as a device that only
serves its owner's other devices. The rest of §7.2 is already enforced: `session.signal` and
`session.close` belong to the session's participants (ADR 0004), and `namespace.join` and
`namespace.discover` follow from the namespace.

## Rules

- **An optional `permissions` claim narrows the session permissions per namespace:** a map from
  namespace ID to a list of `session.create` and `session.accept`. A namespace the map does not
  list holds both, so tokens without the claim keep working as before. A listed namespace holds
  only what its list names, possibly nothing.
- **The claim only narrows the token's own namespaces.** A key the `namespaces` claim does not
  list, or a permission outside the two, rejects the token with `invalid_token`.
- **`session.create` is checked on the requester,** with the namespace: without it,
  `not_authorized`, the code an unauthorized namespace gets, and no request reaches the target.
- **`session.accept` is checked on the target's connection when the request arrives,** where the
  target's token is, on whichever instance holds it. Without it, the connection answers the
  requester with `session.rejected` and its client never sees the request: a refusal by policy looks
  like one by the user, so the requester learns nothing of the target's permissions.
- **`session.accept` is checked again on the target's answer,** since an `auth.refresh` may have
  withdrawn it meanwhile: the answer gets `not_authorized`, and the session stays `pending` until
  the target rejects it or it times out.
- **A refresh that withdraws a permission ends nothing.** The permissions gate creating and
  accepting sessions, not the sessions already accepted; removing the namespace still ends them
  (ADR 0007).
- **Discovery is unchanged:** it lists the namespace's present devices, whatever their
  permissions.

## Considered options

- **Objects inside `namespaces`,** such as `{ "id": "...", "permissions": [...] }`. Rejected: it
  changes the type of a claim every backend already emits, and every reader of it in the server.
- **A peer restriction,** such as `"peers": "same_user"`. Deferred: it is not the §7.2 model, and
  it can become another key of the claim when an application needs it.
- **Hiding from discovery the devices one cannot open a session with.** Rejected for now: the
  requester's instance would need the target's permissions, a new field in the presence record and
  in `CoordinationAdapter`, while the target's answer already enforces them.
- **Answering a target without `session.accept` with `peer_unavailable` at creation.** Rejected:
  the requester's instance cannot see the target's token, and holding the session until the
  target's instance answers would change `session.create`'s reply.

## Consequences

- Deny by default holds where the backend lists a namespace; an unlisted namespace grants both
  permissions, as before, so the backend must list a namespace to restrict it.
- A device without `session.create` is reachable but cannot reach; one without `session.accept`
  can reach but every request to it is rejected.
- Withdrawing a permission takes effect within one token lifetime, at the next `auth.refresh`.
