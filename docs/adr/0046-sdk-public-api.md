# SDK public API

**Status:** accepted

ADR 0043 versions `@blindsignal/sdk` semantically, so its first publication fixes a public API that
only a major version can break. Roadmap Phase 12 asks for a review of that API before a stable
release. The review read every export of `packages/sdk/src/index.ts` and `@blindsignal/sdk/testing`,
and how `examples/browser-demo` and `examples/minimal-app` use them. It found one gap, and three
places where the API was larger than intended:

- **No refresh on demand.** After the backend grants a pairing, the next token holds the new
  namespace, but the minimal app had to close the client and connect again to get it
  (`docs/integration-feedback.md`): sessions, joins, and the device's presence dropped with it.
- **`client.iceConfig`** was a public getter, absent from the README, that handed the application
  the TURN credentials only the WebRTC layer needs. Only tests read it.
- **Members the client calls on its objects were public:** the `Session` constructor,
  `activate()`, `receive()`, and `end()`, and `DeviceKey.proof()`. An application calling
  `session.end()` would leave the session ended on its side only.
- **`@blindsignal/sdk/testing`** was exported, but left out of the build.

## Rules

- **`client.refresh()` sends `auth.refresh` now,** with a new token from `accessTokenProvider`. It
  resolves once the server accepts the token, and schedules the next refresh from it; it rejects
  with a `BlindSignalError`, and the connection keeps its current token and its scheduled refresh;
  without a connection, it rejects with `connection_closed`. A refresh on demand that succeeds
  while a scheduled one is retrying ends those retries.
- **The ICE configuration stays inside the SDK.** `rtc.ice_config` reaches only the
  RTCPeerConnection configuration; the client exposes no getter for it.
- **The public API is what `@blindsignal/sdk` and `@blindsignal/sdk/testing` export, minus the
  members tagged `@internal`.** The build strips those from the published types
  (`stripInternal`), and they change with no version contract.
- **`@blindsignal/sdk/testing` is public:** `FakePeerConnection` and `FakeDataChannel` let an
  application test its own code in Node, where no WebRTC stack exists. The build includes them.
- **The SDK README documents the public API (amended with the SDK documentation):**
  `packages/sdk/README.md` names every export of both entry points in a code span, and
  `apps/server/src/sdk-readme.test.ts` fails when one is missing; it lives in the server because
  the SDK's tests have no Node types. The README's examples were compiled against the SDK's types
  when written, which no check repeats. It ships with the package, so it is the SDK
  documentation, with no generated reference.
- **Kept as they are:** `on()` returning the function that removes the listener, with no `off()` or
  `once()`; `connect()` callable again after `close()`; every event and exported type; and the
  `createSocket` and `createPeerConnection` options for tests. Adding to any of them later is a
  minor version.

## Considered options

- **Closing and connecting again after a grant.** Rejected: it ends every session and presence for
  a change only the token carries, and `auth.refresh` exists to renew credentials in place.
- **A generated reference, such as TypeDoc.** Rejected: a tool outside ADR 0001 for about 25
  exports, and the doc comments already reach the editor through the published types.
- **Documenting `iceConfig`.** Rejected: the TURN credentials have no use outside the
  RTCPeerConnection, and spec §12.3 keeps them to `rtc.ice_config`.
- **Hiding the internal members at runtime, with closures or a `WeakMap`.** Rejected: more code to
  guard against an application that already holds the session and the key; `stripInternal` keeps
  them out of the types it compiles against.
- **`@blindsignal/sdk/testing` outside semantic versioning.** Rejected: an application's tests
  depend on it like on any export.

## Consequences

- The minimal app calls `refresh()` after a grant, and then joins the namespace.
- The packaging that publication needs (`exports` pointing at the build, `private`) is left to
  roadmap Phase 12's publishing task.
- A future member the client calls but applications must not is tagged `@internal`.
