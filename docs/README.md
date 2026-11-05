# Documentation

Every document, grouped by who reads it. [`README.md`](../README.md) introduces the project.

## Evaluate

- [`spec.md`](spec.md): the technical specification; §22 defines the MVP.
- [`threat-model.md`](threat-model.md): what BlindSignal protects, against whom, and the risks it
  accepts.
- [`application-e2ee.md`](application-e2ee.md): what BlindSignal protects in a payload, and what
  end-to-end encryption leaves to the application.
- [`roadmap.md`](roadmap.md): the phases, what each delivered, and what is left.
- [`../examples/browser-demo`](../examples/browser-demo/README.md): two tabs opening a DataChannel.

## Integrate an application

- [`onboarding.md`](onboarding.md): from registration to production, step by step. Start here.
- [`token-issuance.md`](token-issuance.md): what the application backend must do to issue tokens the
  server accepts.
- [`../packages/sdk/README.md`](../packages/sdk/README.md): the browser SDK, every export.
- [`../examples/minimal-app`](../examples/minimal-app/README.md): the shortest complete
  integration, a page and its backend.
- [`../examples/backend-issuer`](../examples/backend-issuer/README.md): a backend that issues tokens
  and grants pairings.
- [`tailscale.md`](tailscale.md): a laptop and devices on one tailnet, running the minimal app.

## Operate the server

- [`deployment.md`](deployment.md): choosing a topology, what every production deployment needs, and
  upgrading. Start here.
- [`../apps/server/README.md`](../apps/server/README.md): every setting and metric of the server.
- Topologies:
  - [`self-hosted.md`](self-hosted.md): one host with Docker Compose and Caddy.
  - [`vps.md`](vps.md): one VPS behind a firewall, with Coturn on the same host.
  - [`cloud-run.md`](cloud-run.md): Cloud Run, with the registry in Secret Manager.
  - [`supabase.md`](supabase.md): Supabase as the PostgreSQL provider.
- [`turn-operations.md`](turn-operations.md): running Coturn for BlindSignal.
- [`application-lifecycle.md`](application-lifecycle.md): registering, suspending, and revoking
  applications and devices.
- [`secrets-and-keys.md`](secrets-and-keys.md): every secret, its rotation, and what to do after a
  compromise.
- [`backup-and-recovery.md`](backup-and-recovery.md): what to back up, and restoring PostgreSQL.
- [`external-testing.md`](external-testing.md): the Compose workflow, and testing across networks.

## Reference

- [`protocol.md`](protocol.md): every signaling message, error code, and close code.
- [`../GLOSSARY.md`](../GLOSSARY.md): the domain terms.
- [`adr/`](adr): the architecture decision records, numbered in the order they were made.

## Records

Dated reports. Each keeps what was true when it was written.

- [`connectivity-report.md`](connectivity-report.md): browsers on separate networks connecting.
- [`load-report.md`](load-report.md): each load test run against the server defaults.
- [`security-review.md`](security-review.md): each security and abuse review, and the state of its
  findings.
- [`integration-feedback.md`](integration-feedback.md): what building the examples taught.
- [`../packages/sdk/CHANGELOG.md`](../packages/sdk/CHANGELOG.md) and
  [`../apps/server/CHANGELOG.md`](../apps/server/CHANGELOG.md): each release.

## Contribute

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): setup, commands, checks, and conventions.
- [`../SECURITY.md`](../SECURITY.md): reporting a vulnerability.
