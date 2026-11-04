# Cloud Run deployment

BlindSignal as a Cloud Run service, from the production image (ADR 0033). The decisions are in
`docs/adr/0039-cloud-run-deployment.md`. **This guide has not been tested on Cloud Run.** Every
platform fact below comes from Google's documentation as read on 2026-11-03. The image was run
locally with this guide's settings: read-only, the registry mounted read-only in its own directory,
the migration started as the job starts it, with and without PostgreSQL and Valkey. The
[open questions](#open-questions) list what only a real deployment settles.

Every command names its project with `--project`: check `gcloud config list` first, so nothing
lands in the project your shell happens to point at.

## What Cloud Run changes

| Platform behavior | Consequence for BlindSignal |
| --- | --- |
| A WebSocket is a request, cut at the service's request timeout: at most 60 minutes, default 5. | `--timeout=3600` and `BLINDSIGNAL_MAX_CONNECTION_SECONDS=3300`, so the server closes each connection with `1001` before the platform cuts it (ADR 0029). |
| Each open WebSocket counts toward the instance's concurrency, at most 1000. The `gcloud` default is 80 per vCPU. | `--concurrency=1000` and `BLINDSIGNAL_MAX_CONNECTIONS=1000` (ADR 0030). |
| `SIGTERM`, then `SIGKILL` 10 seconds later; Cloud Run stops routing on the signal. | The defaults fit: `BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS=8` and no delay (ADR 0031). |
| One port reaches the container, `8080` by default, in `PORT`. | Keep `8080`, the default of `BLINDSIGNAL_PORT`. The admin port and `/metrics` stay unreachable; metrics leave by OTLP (ADR 0038). |
| Instances share nothing, and the platform starts several under load. | Without PostgreSQL and Redis, `--max-instances=1`. With both, any number. |
| No signals reach the process but `SIGTERM`. | A registry change is a new secret version and a new revision; `SIGHUP` is unavailable. |
| By default, CPU only while a request is open. An open WebSocket counts, so an instance with clients has CPU. | `--no-cpu-throttling`, so the device sweep, the registry sync, and OTLP pushes run with no client connected. It bills the instance for its whole life. |

## Requirements

- A Google Cloud project for BlindSignal, with Cloud Run, Artifact Registry, and Secret Manager
  enabled.
- A service account for the service, with `roles/secretmanager.secretAccessor` on its secrets.
- With PostgreSQL and Redis: a database the instances reach, such as Supabase (`docs/supabase.md`)
  or Cloud SQL, and Memorystore for Valkey or Redis in a VPC the service joins through Direct VPC
  egress (`--network`, `--subnet`, `--vpc-egress=private-ranges-only`). Set its
  `maxmemory-policy` to `noeviction` (ADR 0035), and give each deployment that shares it a
  `BLINDSIGNAL_REDIS_PREFIX` of its own. Turn on its in-transit encryption and its
  authentication, and make `BLINDSIGNAL_REDIS_URL` a `rediss://` URL with the password: every
  workload in the VPC reaches the instance, and Redis holds the `jti` claims and the device
  claims.
- TURN, when you need it, on a host of its own: Cloud Run serves HTTP, not the UDP a relay needs
  (`docs/turn-operations.md`, `docs/vps.md`).

The examples use `PROJECT_ID`, `REGION`, and a service account `blindsignal@PROJECT_ID.iam.gserviceaccount.com`.

## Image

The image is not published to a registry (ADR 0033); build it from a checkout of the release and
push it to Artifact Registry. Cloud Run runs `linux/amd64`:

```sh
docker build --platform linux/amd64 -t REGION-docker.pkg.dev/PROJECT_ID/blindsignal/server:VERSION .
docker push REGION-docker.pkg.dev/PROJECT_ID/blindsignal/server:VERSION
```

## Secrets and the registry

Each value goes to Secret Manager and reaches the service through `--set-secrets`
(`docs/secrets-and-keys.md`):

| Secret | Exposed as |
| --- | --- |
| `blindsignal-registry` | The file `/etc/blindsignal/registry/registry.json` |
| `blindsignal-database-url` | `BLINDSIGNAL_DATABASE_URL` |
| `blindsignal-redis-url` | `BLINDSIGNAL_REDIS_URL` |
| `blindsignal-turn-secret` | `BLINDSIGNAL_TURN_SECRET` |
| `blindsignal-otlp-headers` | `OTEL_EXPORTER_OTLP_HEADERS`, when the backend takes header credentials |

The registry is not secret (ADR 0034), but Secret Manager is the store Cloud Run mounts as a file
with no extra service, and it versions every change. Mount it in a directory of its own: a mount
hides whatever the image has at that path.

**Reference a version number, never `latest`.** Cloud Run reads a mounted secret from Secret
Manager on every read, so with `latest` an instance started after a new version loads a registry
its siblings do not have. The server reads the file at startup only, so a pinned version keeps
every instance of a revision on the same registry, and the change reaches them all through the
next revision.

```sh
gcloud secrets create blindsignal-registry --project=PROJECT_ID --data-file=registry.json
gcloud secrets versions add blindsignal-registry --project=PROJECT_ID --data-file=registry.json  # each change
```

## Migrations

With PostgreSQL, apply the migrations before each release, from a Cloud Run job running the same
image with the same database URL (ADR 0019); the server refuses a schema behind its release:

```sh
gcloud run jobs deploy blindsignal-migrate --project=PROJECT_ID --region=REGION \
  --image=REGION-docker.pkg.dev/PROJECT_ID/blindsignal/server:VERSION \
  --command=node --args=adapters/storage/postgresql/src/migrate-command.ts \
  --service-account=blindsignal@PROJECT_ID.iam.gserviceaccount.com \
  --set-secrets=BLINDSIGNAL_DATABASE_URL=blindsignal-database-url:1 \
  --max-retries=0 --wait
```

Add the service's `--network`, `--subnet`, and `--vpc-egress` when the database is on a private
address.

## Service

One instance, with no external dependency:

```sh
gcloud run deploy blindsignal --project=PROJECT_ID --region=REGION \
  --image=REGION-docker.pkg.dev/PROJECT_ID/blindsignal/server:VERSION \
  --service-account=blindsignal@PROJECT_ID.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --timeout=3600 --concurrency=1000 --no-cpu-throttling \
  --min-instances=1 --max-instances=1 \
  --set-secrets=/etc/blindsignal/registry/registry.json=blindsignal-registry:1 \
  --set-env-vars=BLINDSIGNAL_REGISTRY_PATH=/etc/blindsignal/registry/registry.json,BLINDSIGNAL_ALLOWED_ORIGINS=https://app.example.com,BLINDSIGNAL_MAX_CONNECTION_SECONDS=3300,BLINDSIGNAL_MAX_CONNECTIONS=1000 \
  --startup-probe=httpGet.path=/healthz,httpGet.port=8080,periodSeconds=1,failureThreshold=30
```

Several instances add PostgreSQL and Redis, the VPC flags, and a higher `--max-instances`:

```sh
  --max-instances=10 \
  --network=NETWORK --subnet=SUBNET --vpc-egress=private-ranges-only \
  --set-secrets=/etc/blindsignal/registry/registry.json=blindsignal-registry:1,BLINDSIGNAL_DATABASE_URL=blindsignal-database-url:1,BLINDSIGNAL_REDIS_URL=blindsignal-redis-url:1
```

- **`--allow-unauthenticated`:** browsers reach the service without Google credentials; the
  server authenticates every connection with the application's token.
- **`--min-instances=1`:** an instance stays up between clients, so reconnects after a deployment
  meet a warm instance. Drop it to pay nothing while idle, at the cost of a cold start for the
  first client.
- **TURN:** add `BLINDSIGNAL_TURN_URLS` and the `BLINDSIGNAL_TURN_SECRET` secret
  (`docs/turn-operations.md`).
- Leave `--port` unset: the server listens on `BLINDSIGNAL_PORT`, `8080` by default, which is
  Cloud Run's default too.

`wss://` reaches the service at its `run.app` URL, or a custom domain mapped to it.

## Client IP

The per-IP limits (ADR 0011) key on the client IP, taken from the TCP peer unless the peer is a
trusted proxy (`BLINDSIGNAL_TRUSTED_PROXIES`). Google documents neither the peer address a Cloud
Run container sees nor how its front end writes `X-Forwarded-For`, and this guide has not measured
them.

- Without a trusted proxy, every client may share the front end's address, and with it
  `BLINDSIGNAL_MAX_UNAUTHENTICATED_PER_IP` and the connection-attempt rate limit: past them,
  clients get HTTP `429` at the upgrade.
- **Never trust `0.0.0.0/0`.** The server reads `X-Forwarded-For` right to left, skipping trusted
  hops; with every address trusted it lands on the leftmost entry, which the client writes.

Before relying on the per-IP limits, find the peer address and the header's layout on a test
service, and set `BLINDSIGNAL_TRUSTED_PROXIES` to the front end's range only.

## Metrics and logs

- **Logs:** Cloud Run collects stdout. Each line is one JSON object with `level` and `event`
  (ADR 0037), so Cloud Logging can filter on `jsonPayload.event`. The `_Default` bucket keeps
  logs 30 days, and logs with a client IP may stay 14 at most (ADR 0012): set
  `BLINDSIGNAL_LOG_LEVEL=warn`, which writes no client IP, or route the service's logs to a
  bucket created with `--retention-days=14` and exclude them from `_Default`.
- **Metrics:** `/metrics` is on the admin port, which Cloud Run does not expose. Set
  `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP endpoint (ADR 0038): a backend that takes header
  credentials, through `OTEL_EXPORTER_OTLP_HEADERS`, or an OpenTelemetry Collector running as a
  sidecar of the service, on `http://localhost:4318`, that forwards to Google Cloud. An endpoint
  that takes credentials in `OTEL_EXPORTER_OTLP_HEADERS` must be `https://`: over `http://` they
  cross the network in the clear. With
  `--no-cpu-throttling`, pushes run with no client connected.

## Releases and registry changes

A new revision starts new instances; Cloud Run sends `SIGTERM` to the old ones, which close their
connections with `1001`, and the SDK reconnects to the new revision.

- **Release:** build and push the image, run the migration job with it, then `gcloud run deploy`
  with the new image.
- **Registry change:** add a secret version, then deploy with the new version number in
  `--set-secrets` (`docs/application-lifecycle.md`).
- **Secret rotation:** add a version and deploy with it, following `docs/secrets-and-keys.md`.

## Open questions

What a deployment still has to confirm:

- The peer address and the `X-Forwarded-For` layout, for `BLINDSIGNAL_TRUSTED_PROXIES`.
- That the old revision's instances get `SIGTERM` once the new one serves, and that the 3300-second
  lifetime closes connections before the 3600-second timeout.
- That the `node` user of the image can read the mounted registry file.
- Memorystore and Cloud SQL through Direct VPC egress, and the Collector sidecar.
