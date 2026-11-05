# Publishing releases

**Status:** accepted

ADR 0043 versions the SDK and the server, tags each release, and starts both at `0.1.0` on the
first publication, but left where they are published, and how. ADR 0033 kept the image
unpublished until a release scheme existed, and ADR 0046 left the SDK's packaging to this task:
its `exports` pointed at the TypeScript sources and every package was `"private": true`.

## Rules

- **The SDK and the protocol are published to npm,** as `@blindsignal/sdk` and
  `@blindsignal/protocol`, public under the `@blindsignal` scope. They are no longer `private`; the
  other packages stay so (ADR 0043).
  - In the workspace, `exports` keep pointing at `src/*.ts`, so tests and examples need no build.
  - `publishConfig.exports` points the published package at `dist/`: JavaScript and types for `.`
    and, in the SDK, `./testing`. `files` ships `dist/` only, without source maps; pnpm adds the
    README and the repository's `LICENSE`, and replaces `workspace:*` with the protocol's version.
  - `prepack` empties `dist/` and builds, so a publication never ships a stale or leftover file.
  - `apps/server/src/sdk-package.test.ts` packs both, installs them where no workspace link
    resolves them, type-checks an application with a bundler and with Node's resolution, and
    imports them.
- **CI publishes them from each `sdk-v<x.y.z>` tag,** through `.github/workflows/npm-publish.yml`,
  with npm's trusted publishing: npm trusts that workflow in the `npm` environment through OIDC,
  so no npm token exists, and each version carries a provenance attestation. Both packages take
  the SDK's version.
  - The job fails unless the tagged commit is on `main` and both `package.json` files hold the
    tag's version.
  - `pnpm pack` builds each tarball, applying `publishConfig` and the protocol's version, and
    `npm publish` uploads it. The protocol goes first, since the SDK depends on its exact version.
  - A rerun skips a version already published, so a run that failed between the two packages
    completes.
  - Each package's npm settings name this repository, workflow, and environment as its trusted
    publisher, and require two-factor authentication while disallowing tokens. `0.1.0` was
    published by hand, before the workflow existed.
- **The server image is published to Docker Hub, as `allisson/blindsignal`,** by
  `.github/workflows/docker-push.yml`, for `linux/amd64` and `linux/arm64`, each built on a
  native runner and joined into one manifest list:
  - every push to `main`: `main` and `sha-<commit>`, for testing what is about to be released;
  - each `server-v<x.y.z>` tag: `<x.y.z>`, `<x.y>`, and `latest`.

  It logs in with the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`, a Docker Hub
  access token limited to that repository. `latest` comes from release tags only.
- **The server reports its release:** `service.version` in the OpenTelemetry resource and
  `version` in `server.listening`, both from `apps/server/package.json`, so an operator sees which
  release each instance runs during a rolling upgrade.
- **A release is tagged on a commit of `main` that passed CI.** The release's pull request sets
  the version and writes the `CHANGELOG.md` entry (ADR 0043); pushing the tags after its merge
  publishes the image and the packages.

## Considered options

- **GitHub Container Registry.** Rejected: the maintainer's other projects publish to Docker Hub,
  where operators look first.
- **Publishing to npm by hand.** Done for `0.1.0`, then replaced: it needs the maintainer's
  one-time password on each release, and a published version cannot show which commit built it.
- **An npm automation token in a repository secret.** Rejected: a long-lived credential that can
  publish, where trusted publishing needs none.
- **`pnpm publish` in CI.** Rejected: npm documents its own client's OIDC exchange; `pnpm pack`
  keeps pnpm's packing, which `apps/server/src/sdk-package.test.ts` checks.
- **A required reviewer on the `npm` environment.** Rejected: pushing the tag is already the
  maintainer's approval of the release.
- **`exports` pointing at `dist/` in the workspace too.** Rejected: every test, type check, and
  example would need a build first.
- **Signing the image.** Deferred: the build's default provenance attestation is attached; a
  signature waits until an operator asks to verify one.
- **Testing the image again before pushing it.** Rejected: CI's `image` job runs it on every pull
  request (ADR 0033), and a tag goes only on a commit that passed it.

## Consequences

- ADR 0033's unpublished image and ADR 0046's packaging are settled here; operators can still
  build the image from a checkout.
- Every merge to `main` pushes a `main` image: the secrets must exist before this workflow
  reaches `main`, or its runs fail.
- An `sdk-v` tag pushed before both packages name the workflow as their trusted publisher fails to
  publish; rerunning the job after configuring them completes the release.
- `pnpm build` and `pnpm pack` leave `dist/` in both packages; it is ignored by git.
- `apps/server/package.json` stays `private`, but its version is the server's release.
