# Per-application usage metrics

**Status:** accepted

Spec §8.4 and §18 ask for per-application metrics and usage reporting: connections and sessions
per application, rate-limit events, quota consumption, and message counts. ADR 0012 allowed
metric labels from closed catalogs only. The application ID becomes a label too, on a separate set
of series, and `GET /metrics` on the admin port is the usage report.

## Rules

- **The label is `app_id`,** set only from a verified token's application, so its values are
  bounded by the registry and an unknown or forged `app_id` never makes a series. Before the token
  is verified, a connection counts only in the aggregate series.
- **Series:**

| Metric | Type | Labels |
|---|---|---|
| `blindsignal_application_connections` | gauge | `app_id`: authenticated connections |
| `blindsignal_application_sessions` | gauge | `app_id`: sessions pending or active |
| `blindsignal_application_messages_total` | counter | `app_id`: valid messages from authenticated connections |
| `blindsignal_application_errors_total` | counter | `app_id`, `code`: every `error` sent once the token is verified, `rate_limited` and `quota_exceeded` included |
| `blindsignal_application_sessions_created_total` | counter | `app_id` |

- **The aggregate series stay** as they were, so dashboards built on them keep working.
- **No user, device, namespace, or address label,** as ADR 0012 requires.

## Considered options

- **An `app_id` label on the existing series.** Rejected: it multiplies every series by the number
  of applications, pre-authentication traffic has no application to label, and the existing
  series would change their label sets.
- **A usage report endpoint of its own** (JSON per application). Rejected: Prometheus already
  scrapes the admin port, and a second format would duplicate the same counts. OpenTelemetry
  (roadmap Phase 10) may replace both later.

## Consequences

- An operator sees each application's load and rejections, and can alert on them; abuse-triggered
  suspension (spec §8.3) can build on these counts.
- The series are per process: a multi-instance deployment sums them across instances.
- Counters of an application removed from the registry stay until the process restarts.
