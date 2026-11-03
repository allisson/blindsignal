# Registry propagation between instances

**Status:** accepted

ADR 0021 stores the last accepted registry in PostgreSQL, and ADR 0023 shares the rest of the
server's state through Redis. A reload still reached only the instance that received `SIGHUP`:
the others kept accepting tokens of a suspended or revoked application, and kept the connections
of its devices and of revoked devices open (spec §5.5, §6.3). This ADR propagates a reload to
every instance.

## Rules

- **An instance that installs a reload publishes `registry.changed`** on the `registry` topic, a
  signal with no registry in it. A failed publish logs `registry.publish_failed` and keeps the
  reload; the other instances catch up at their next sync.
- **Every instance that receives it syncs from storage.** It reads the stored registry, which the
  reloading instance wrote before installing it (ADR 0021), adds every application it saw
  revoked, installs the result in its copy for token verification without writing it back, and
  closes the connections the change makes unavailable, as a reload does (ADR 0005). The instance
  that published receives its own event; syncing again changes nothing.
- **Every instance also syncs every `BLINDSIGNAL_REGISTRY_SYNC_INTERVAL_SECONDS`** (default 60),
  since events are delivered at most once and a Redis outage loses them (ADR 0022). It costs one
  query per interval per instance.
- **Syncs and reloads run one at a time,** in the order they arrive, so each reload is checked
  against what the previous change installed.
- **A sync that cannot read storage logs `registry.sync_failed`** and keeps the current registry;
  the next event or interval tries again.
- **Only with `BLINDSIGNAL_REDIS_URL`.** A single instance has nothing to follow.

## Considered options

- **The event alone.** Rejected: an event lost while Redis is unreachable leaves an instance
  accepting a suspended application until its next reload.
- **The periodic sync alone.** Rejected: a suspension would take up to a whole interval to reach
  every instance, where the event takes a round trip.
- **The event carrying the registry.** Rejected: storage already has it, and an instance must
  read storage anyway to sync after a lost event.
- **Every instance rereading its own file on the event,** as if each received `SIGHUP`. Rejected:
  during a rolling deployment the files differ, and each instance would store its own.

## Consequences

- A reload reaches every instance within a round trip through Redis, or within the sync interval
  when the event is lost.
- The registry file of the instance that reloaded last decides for every instance until another
  reloads. Startup stores the file too without publishing, so an instance that starts with an
  older file, one where a suspended application is still `active`, reactivates it everywhere at
  the next sync. Revocation still holds: an instance whose file would undo one does not start
  (ADR 0021).
- An instance installs a registry it did not read from its own file; its next `SIGHUP` checks its
  file against the stored registry as before.
