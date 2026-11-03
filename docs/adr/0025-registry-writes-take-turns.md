# Registry writes take turns

**Status:** accepted

ADR 0021 checks the registry file against the stored registry and stores the result. The check
and the write were separate operations, and the PostgreSQL `replaceAll` deleted and inserted rows
without a lock. Two instances loading at once, at startup or on `SIGHUP`, raced twice:

- The second transaction's `DELETE` did not see the rows the first had just inserted, so its
  `INSERT` failed on the primary key, and that instance did not start or rejected its reload.
- Both instances read the stored registry before either wrote it, so a file that still had an
  application `active` could store it over another instance's revocation. Revocation stopped
  being terminal across instances, and ADR 0024 then spread the reactivation to every instance.

## Rules

- **`ApplicationRepository.replaceWith(next)`, a new method,** replaces the registry with what
  `next` returns for the stored registry, or keeps it when `next` returns `undefined`. Calls on
  every instance take turns, so each decides on what the previous one stored.
- **The server checks and stores the file inside `replaceWith`.** At startup and on `SIGHUP`, it
  reads the file first, then, in one call, adds the applications it saw revoked to the stored
  registry, checks the file against them (ADR 0005, ADR 0021), and stores the result, or keeps the
  stored registry when the check fails. Only then does it install the registry in its copy.
- **PostgreSQL takes a transaction-scoped advisory lock,** key `(0x42534947, 1)`, reads the rows,
  and deletes and inserts in the same transaction. `replaceAll` is `replaceWith` that ignores what
  is stored, under the same lock. A collision with `hashtext(app_id)` of device enrollment
  (ADR 0020) only makes the two wait for each other.
- **The in-memory adapter** reads and writes in one synchronous step, which is already a turn.
- **The storage contract suite** runs concurrent `replaceWith` calls, each adding one application,
  and expects every one of them stored.

## Considered options

- **The lock inside `replaceAll` alone.** Rejected: it ends the primary-key failure, but the check
  still reads the stored registry outside the turn, so a concurrent load can still undo a
  revocation.
- **An upsert with `ON CONFLICT`,** deleting what the new registry lacks. Rejected: no failure,
  but two concurrent writes mix both registries, and the check still reads outside the write.
- **`SERIALIZABLE` transactions with retries.** Rejected: a retry loop for what one lock
  serializes, as in ADR 0020.

## Consequences

- Instances that start or reload at once store one after another; the last one decides, as before
  (ADR 0021, ADR 0024), but none can store a registry that undoes a revocation another stored.
- A registry check runs while the lock is held; it parses a file already in memory and makes no
  network call.
