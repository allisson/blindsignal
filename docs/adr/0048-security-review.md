# Security review

**Status:** accepted

Phase 12's acceptance criteria require that the security review has no open blocking findings
before a stable release, but nothing defined what makes a finding blocking, when a review runs
again, or how the dependencies the packages ship are kept free of known advisories. The first
review, before the first release, followed the five trust boundaries of `docs/threat-model.md`, one
reviewer per boundary; its findings are in `docs/security-review.md`.

## Rules

- **A finding is blocking when it violates an invariant of `AGENTS.md`, or when a mitigation that
  the threat model or an ADR declares is not applied, or has no negative test.** A blocking finding
  is fixed before the release it was found for. Every other finding is non-blocking.
- **A non-blocking finding is fixed, accepted, or open.** An accepted one is added to the threat
  model's accepted risks with its reason; an open one is tracked in the roadmap until it is fixed
  or accepted.
- **`docs/security-review.md` records each review:** its scope, its date, and every finding with
  its state and the change that fixed it. A finding someone could exploit before it is fixed is
  recorded once fixed, not before.
- **A review runs before every minor and every major release** of the SDK or the server (ADR
  0043), covering each trust boundary of the threat model and what changed since the last review.
  A change that adds a trust boundary or a surface updates the threat model in the same change.
- **The dependencies stay current and free of known advisories:**
  - Dependabot proposes updates to the image's base, the GitHub Actions, and the workspace's npm
    dependencies, weekly; minor and patch updates of npm come grouped.
  - The actions are pinned by commit, with the version in a comment, since a tag can be moved.
  - CI runs `pnpm audit --prod` on every pull request: a known advisory in what the packages
    ship fails it. Development dependencies are left out: they never run in a deployment or a
    browser.
- **Vulnerabilities are reported privately,** through GitHub's private vulnerability reporting, as
  `SECURITY.md` says; they get fixes as ADR 0044 defines.

## Considered options

- **Blocking by a severity score, such as CVSS.** Rejected: scoring each finding is a judgment of
  its own, where an invariant or a declared mitigation is already written down.
- **A review before every major release only.** Rejected: a minor release can add a surface, as
  pairing and proof-of-possession did.
- **Auditing development dependencies too.** Rejected: their advisories, in test and build tools,
  would fail CI over code no deployment runs.
- **Actions referenced by tag.** Rejected: whoever controls the action's repository can move the
  tag to other code, which then runs with the workflow's permissions.

## Consequences

- An advisory published after a merge fails CI on every pull request until it is answered: an
  update, or, when the vulnerable path is never reached, an entry in `pnpm.auditConfig` of
  `package.json` with its reason.
- Dependabot opens pull requests on its own; each goes through CI and review like any other.
- The review's open findings are hardening, tracked in the roadmap, and none blocks a release.
