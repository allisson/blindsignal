# Changelog

The server, its image `allisson/blindsignal`, and its operator surface follow semantic versioning
(`docs/adr/0043-semantic-versioning.md`). Each release is tagged `server-v<x.y.z>`.

## 0.1.0

The first publication. It speaks protocol major `1` (`docs/protocol.md`).

- **Signaling:** authentication against a registry of applications and their trusted issuers
  (ADR 0005, ADR 0006), namespace and session authorization from token claims (ADR 0007,
  ADR 0040), proof-of-possession (ADR 0041), pairing (ADR 0042), presence, and `rtc.*` relayed
  only within accepted sessions. No application payload reaches the server.
- **Limits:** per-application quotas and rate limits, validated by the load tests (ADR 0011,
  ADR 0049, `docs/load-report.md`), bounded queues (ADR 0013), a maximum session duration
  (ADR 0014), a maximum connection lifetime and a connection cap (ADR 0029, ADR 0030), and abuse
  alerts (ADR 0016).
- **TURN:** short-lived credentials for Coturn's `use-auth-secret` (ADR 0017).
- **Storage and coordination:** in memory for one instance; PostgreSQL for device records and the
  registry, and Redis or Valkey for several instances (ADR 0020 to ADR 0027).
- **Operations:** health and readiness (ADR 0028), graceful shutdown (ADR 0031), JSON logs with a
  level (ADR 0037), metrics on `/metrics` and over OTLP (ADR 0038), and the release in
  `service.version` and `server.listening` (ADR 0050).
- **Image:** `allisson/blindsignal:0.1.0`, for `linux/amd64` and `linux/arm64`, read-only and as
  `node` (ADR 0033, ADR 0050). Migrations run from it before the server starts (ADR 0019).
