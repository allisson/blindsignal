# Security policy

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting: the repository's
**Security** tab, then **Report a vulnerability**. Do not open a public issue, pull request, or
discussion for it.

Include what is affected (the SDK, the server, an adapter, or a document), the version or commit,
and the steps that show the problem. The report stays private until a fix is released, and then
becomes a security advisory that credits you, unless you ask otherwise.

## Supported versions

As `docs/adr/0044-support-and-upgrade-policy.md` defines:

- **Within `0.x`,** only the latest release of the SDK and of the server get fixes.
- **From `1.0.0`,** the latest minor version of the current major gets fixes, and the previous
  major gets security fixes for 6 months after the current one is released.

## Scope

What BlindSignal protects, against whom, and the risks it accepts are in `docs/threat-model.md`;
the findings of each security review, in `docs/security-review.md`. An accepted risk listed there
is not a vulnerability, unless BlindSignal does worse than it states. The examples in `examples/`
show integrations and are not meant to run in production.
