# blindsignal
BlindSignal is an independent connectivity infrastructure that allows authorized applications and devices to discover each other and establish peer-to-peer communication sessions.

Run the signaling server locally or with Docker Compose: see [`apps/server/README.md`](apps/server/README.md).

Use it from a browser with the SDK: see [`packages/sdk/README.md`](packages/sdk/README.md), and
[`examples/browser-demo`](examples/browser-demo/README.md) for two tabs opening a DataChannel.
[`examples/minimal-app`](examples/minimal-app/README.md) adds a backend that issues tokens and grants
pairings; [`docs/token-issuance.md`](docs/token-issuance.md) says what such a backend must do.

Integrating an application: start with [`docs/onboarding.md`](docs/onboarding.md).
