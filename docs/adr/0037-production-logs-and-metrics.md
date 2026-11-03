# Production logs and metrics

**Status:** accepted

Phase 10 asks for the Phase 3 structured logs and metrics to be extended for production use. The
server writes one JSON line per event and serves counters and gauges on `/metrics` (ADR 0015,
ADR 0028), but it logs every connection at `info` with no way to filter, an uncaught error leaves
the process as plain text on standard error, outside the log pipeline, and nothing shows the
process itself: its memory, its restarts, or an event loop that stalls. Spec §18 lists metrics
that the server cannot observe at all.

## Rules

- **`BLINDSIGNAL_LOG_LEVEL`, `info` (default), `warn`, or `error`, drops the events below it.**
  Startup logs at every level until the configuration is read. At `warn`, the per-connection
  events, and with them every logged client IP, are not written.
- **An uncaught exception or unhandled rejection logs `server.crashed` (`error`) and exits with
  status 1,** as Node.js would. The entry carries the origin, the error's name, and its stack
  frames, never its message, which may quote values.
- **The process's own gauges, under the names Prometheus clients commonly use:**
  `process_start_time_seconds`, `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`,
  and `nodejs_eventloop_delay_seconds{stat="p99"|"max"}`, from `monitorEventLoopDelay`. The delay
  covers the time since the previous scrape: each scrape resets it, so one scraper reads it per
  interval.
- **`blindsignal_devices_expired_total` counts the device records the retention sweep deletes**
  (ADR 0012), next to the `devices.expired` log.
- **Spec §18 metrics about WebRTC itself stay with the client.** Negotiation success, direct versus
  relay, and ICE connection duration happen between browsers; the server sees only the messages
  it relays and how sessions end. `apps/server/README.md` maps each §18 metric to its series, or
  to where it can be measured.

## Considered options

- **A logging library, such as `pino`.** Rejected: one more dependency (ADR 0001) for a level
  filter and a JSON line the server already writes.
- **`prom-client` for the process metrics.** Rejected: OpenTelemetry, still to be decided, replaces
  the exposition, and four gauges do not need a library meanwhile.
- **The crash's message in the log.** Rejected: an error from a driver or a parser can quote a
  configuration value or a client's input (spec §18).
- **The event loop delay over the process's lifetime.** Rejected: after hours a stall no longer
  moves the 99th percentile.
- **Latency histograms for authentication and session creation.** Deferred to OpenTelemetry, which
  brings its own histogram type; ADR 0038 adds them.

## Consequences

- Two scrapers of the same instance each read only the delay since the other's scrape.
- At `warn` or `error`, `server.listening` is not written; the ports are the configured ones.
- The event loop monitor's cost was within the measurement's variation: on the development
  machine, 2 million empty event loop turns took between 0.3% less and 2.9% more time with it on,
  over three rounds; a turn that handles a message costs far more than an empty one.
