# Semantic versioning

**Status:** accepted

Phase 12 asks for semantic versioning before a stable release, and ADR 0002 kept every package
`"private": true` at `0.0.0` until it was defined. The protocol already has its own version: a
single integer major, with the changes allowed within it (`docs/protocol.md` §2). What is left is
which artifacts carry a public version, how those versions relate to the protocol and to each
other, and what counts as a breaking change in each.

## Rules

- **Two artifacts carry a semantic version, and the protocol keeps its integer.**
  - **The SDK**, `@blindsignal/sdk`, with `@blindsignal/protocol`, which it depends on at runtime.
  - **The server**: its image, environment variables, registry format, metrics, commands
    (`start`, `migrate`), and PostgreSQL migrations.
  - **The protocol**: `version`, one integer per major (`docs/protocol.md` §2).

  `packages/core`, `adapters/*`, `packages/dev-issuer`, and `examples/*` are internal: they stay
  `"private": true` at `0.0.0`, and change with no version contract.
- **The SDK and the server are versioned independently.** The protocol is what joins them: each
  major version of the SDK and of the server states the protocol majors it speaks, and any SDK and
  server sharing one interoperate.
- **A breaking change of the SDK** is a major version: removing or renaming an export, an option,
  an event, or a member; changing the type or the default of an existing one; dropping a protocol
  major; or dropping a supported browser. A new optional option, event, or member is a minor
  version; a fix that keeps the documented behavior is a patch.
- **A breaking change of the server** is a major version: removing or renaming an environment
  variable, or changing a default in a way that changes behavior; making a registry field required,
  or removing one; removing or renaming a metric or one of its labels; a migration that the
  previous server version cannot run against; or dropping a protocol major. A new environment
  variable whose default keeps the behavior, a new optional registry field, a new metric, and an
  additive migration are minor versions; a fix is a patch.
- **Logs are not part of the contract,** except the name and fields of an event that a document
  tells operators to watch for, such as `registry.reload_rejected` or `server.crashed`.
- **A new protocol major is a minor version where it is added, and a major one where it is
  dropped.** Which protocol majors a server keeps at once is ADR 0044's (amended).
- **Versions start at `0.1.0` on the first publication.** Within `0.x`, a breaking change raises
  the minor version and anything else the patch. `1.0.0` comes when Phase 12's acceptance criteria
  are met.
- **Each release is a git tag,** `sdk-v<x.y.z>` or `server-v<x.y.z>`, with a hand-written
  `CHANGELOG.md` entry for that artifact, written in the release's pull request from its
  Conventional Commits. No release tool is added.

## Consequences

- Nothing is published yet: the `package.json` versions stay `0.0.0` until publishing the SDK and
  the server image (roadmap Phase 12) sets the first `0.1.0`.
- A server can upgrade without an SDK release, and the reverse, while both speak one protocol
  major.
- A pull request that changes the SDK's API or the server's operator surface says whether it is
  breaking, so the next release's changelog and version follow from it.
- The adapters' interfaces stay free to change: a third-party adapter would need its own decision.
