# OpenTelemetry metrics

**Status:** accepted

Spec §18 prefers OpenTelemetry for instrumentation, and Phase 10 asks for it. The server counts and
measures through its own `Metrics` class and serves the result as Prometheus text on `/metrics`
(ADR 0015, ADR 0028, ADR 0037). Hosting platforms such as Cloud Run do not scrape an
instance's admin port, so those numbers never leave the instance, and ADR 0037 deferred the
latency histograms to OpenTelemetry.

## Rules

- **Metrics go through the OpenTelemetry metrics SDK.** `Metrics` keeps its interface (`count`,
  `gauge`, `labeledGauge`) and adds `observe` for histograms; handlers do not import
  OpenTelemetry. The dependencies are `@opentelemetry/api`, `core`, `resources`, `sdk-metrics`,
  `exporter-prometheus`, and `exporter-metrics-otlp-http`, all in `apps/server`.
- **`/metrics` keeps its series.** The same names, labels, and Prometheus text format, without
  `target_info` or `otel_scope_*` labels, so dashboards and alerts built on it keep working.
  `blindsignal_dependency_up` becomes a gauge of the SDK and is exported with the rest.
- **OTLP over HTTP is on when `OTEL_EXPORTER_OTLP_ENDPOINT` or
  `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` is set,** every `OTEL_METRIC_EXPORT_INTERVAL`
  milliseconds (60000 by default). The exporter reads OpenTelemetry's own variables, so
  `OTEL_EXPORTER_OTLP_HEADERS` carries a backend's credentials without the server seeing them.
  Scraping `/metrics` keeps working alongside.
- **The resource names the process:** `service.name` is `blindsignal`, and `service.instance.id` is
  a random UUID per process, so a backend keeps the cumulative series of instances apart.
- **A failed export logs `telemetry.export_failed` (`warn`),** without the error, which can quote
  the endpoint's response. On `SIGTERM` the server pushes once more, with what is left of the
  shutdown deadline (ADR 0031); a push still waiting then is dropped and logged the same way, and
  the exit status stays `0`.
- **Two histograms, in seconds:**
  - `blindsignal_authentication_duration_seconds{result}`: `auth.authenticate` from its receipt
    to the reply, with the result `blindsignal_authentications_total` counts. A rate-limited
    attempt is neither counted nor timed.
  - `blindsignal_session_acceptance_seconds`: from `session.create` to `session.accepted`,
    measured by the requester's connection, which receives the acceptance once.

  No `app_id` label: a histogram's buckets multiply its series, and ADR 0015's per-application
  counters already split the load.

## Considered options

- **Prometheus only, without the OTLP exporter.** Rejected: OpenTelemetry would stay a library
  inside the server, and an operator on a platform that does not scrape would still need a
  sidecar.
- **Traces as well.** Rejected for now: a WebSocket connection lasts hours and carries no request
  context, so spans for authentication or session creation would have no parent to join.
- **`prom-client` for the histograms.** Rejected: a second metrics library next to the one the spec
  prefers.
- **Our own variables for the endpoint, such as `BLINDSIGNAL_OTLP_ENDPOINT`.** Rejected:
  collectors, platforms, and operators already set OpenTelemetry's.
- **The OTLP exporter over protobuf or gRPC.** Rejected for now: the HTTP JSON exporter has the
  fewest dependencies, and collectors accept it on port 4318.

## Consequences

- A counter never incremented no longer appears on `/metrics`; its first increment declares it.
- The event loop delay resets on every collection, a scrape or a push: with OTLP on, a scrape reads
  the delay since the previous scrape or push (ADR 0037).
- Every push probes PostgreSQL and Redis too, as a scrape does (ADR 0028).
- The packages and their dependencies take about 18 MB installed alone, half of it
  `@opentelemetry/semantic-conventions`.
- Tested against the OpenTelemetry Collector 0.164.0 on loopback, with the debug exporter: gauges,
  counters, and the authentication histogram arrive with the resource; a stopped collector logs
  `telemetry.export_failed`, and an endpoint that never answers costs the last push, not the exit
  status. Not tested against a managed backend, such as Google Cloud's OTLP endpoint.
