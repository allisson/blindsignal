# BlindSignal

Access-controlled infrastructure that lets registered applications' devices find each other and
signal peer-to-peer sessions, without ever carrying application payloads.

## Language

### Access and trust

**Application**:
A consuming product registered with BlindSignal, identified by a public `app_id`.
_Avoid_: tenant, client, app key

**Issuer**:
The application backend whose signed tokens BlindSignal trusts; each issuer maps to exactly one application.
_Avoid_: identity provider, auth server

**Operator**:
A person who runs a BlindSignal deployment and manages applications and devices through the control plane.
_Avoid_: admin, owner

**Control plane**:
The operator-only channel for registering, suspending, reactivating, and revoking applications and revoking devices; separate from the signaling protocol.
_Avoid_: admin API, dashboard

### Identity

**User**:
The subject (`sub`) an issuer asserts, meaningful only within that application.
_Avoid_: account, member

**Device**:
One installation of an application acting on behalf of a user, with its own identity and revocation status.
_Avoid_: client, peer, node

**SDK**:
The BlindSignal library embedded in an application's frontend.
_Avoid_: client (reserved for the OAuth sense of a public client)

### Connectivity

**Connection**:
One authenticated WebSocket between an SDK and the server.
_Avoid_: socket, session

**Namespace**:
An application-scoped boundary within which devices may discover each other and form sessions.
_Avoid_: room, channel, workspace

**Presence**:
The server's knowledge that a device is currently reachable in a namespace.
_Avoid_: online status

**Session**:
A signaling-coordinated relationship between devices in one namespace, from creation until it closes or is terminated.
_Avoid_: call, room, peer connection

**Participant**:
A device that is a member of an accepted session.
_Avoid_: peer (reserved for the remote end of a DataChannel)
