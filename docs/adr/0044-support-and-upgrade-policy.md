# Support and upgrade policy

**Status:** accepted

ADR 0043 versions the SDK and the server independently, joined by the integer protocol major, and
left to a support policy which protocol majors a server keeps at once. Three facts constrain it.
The SDK sends one `version` in `auth.authenticate`, with no negotiation, and `unsupported_version`
is terminal (`docs/protocol.md` §2), so an SDK speaks one protocol major. Browsers keep running an
old SDK in open tabs, installed PWAs, and cached bundles long after an application ships a new
one. And during a rolling deployment, instances of two server versions share PostgreSQL and
Redis: migrations are expand, then contract, and a server accepts a schema newer than its own
(ADR 0019), but the events and keys the instances exchange through Redis carry no version.

## Rules

- **A server speaks the previous protocol major as long as old SDKs can still be running.**
  Protocol major N+1 is added in a server minor version, next to N. N is dropped only in a later
  server major version, released at least 6 months after the first SDK release that speaks N+1.
- **Each SDK major version speaks one protocol major.** Upgrade the server first: an application
  adopts the SDK of protocol N+1 only once the server it connects to speaks N+1.
- **Rolling upgrades of the server are supported between consecutive minor versions of one
  major,** and from the latest minor version of major N to `N+1.0.0`. Within those steps:
  - a migration keeps the previous version working (ADR 0019);
  - the events and keys the instances exchange through the `CoordinationAdapter` stay readable by
    the previous version, so a format change is expand, then contract, as a migration is.

  An upgrade that skips versions goes through each step in turn. A major version that cannot be
  rolled out next to its predecessor says so in its `CHANGELOG.md` entry, and its upgrade stops
  every instance first.
- **Rolling back the server is redeploying the previous minor version,** which accepts the newer
  schema; migrations are never reverted.
- **Fixes:**
  - **Within `0.x`,** only the latest release of each artifact gets fixes.
  - **From `1.0.0`,** the latest minor version of the current major gets fixes, and the previous
    major gets security fixes for 6 months after the current one is released.

## Considered options

- **One protocol major at a time.** Rejected: the server and every application would have to
  switch at once, and every tab still running the old SDK would end with `unsupported_version`.
- **An SDK that falls back to the previous protocol major on `unsupported_version`.** Rejected
  for now: it changes the protocol and the SDK, where upgrading the server first needs neither.
- **Upgrades that stop every instance.** Rejected as the rule: they drop every connection at once,
  where a rolling upgrade drops each instance's in turn (ADR 0031). It stays the exception a major
  version declares.
- **Fixes for the latest release only, after `1.0.0` too.** Rejected: dropping a protocol major is
  a server major version, and an operator waiting for applications to adopt the new SDK would be
  left with no security fixes meanwhile.

## Consequences

- A server that drops protocol N refuses, with `unsupported_version`, every SDK still speaking it;
  its `CHANGELOG.md` entry names the SDK releases affected.
- A change to a `CoordinationAdapter` event or key format takes two server minor versions: one
  that reads both, then one that stops writing the old.
- No test runs two server versions side by side: the rolling-upgrade rule holds by review of each
  pull request that changes a migration or a coordination format.
- An application that bundles the SDK chooses when to upgrade it; the 6 months are what it has.
