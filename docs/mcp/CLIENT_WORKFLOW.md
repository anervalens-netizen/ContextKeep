# Client workflow

MCP interface version: 2.17.1. Supported protocol contract: 2026-07-28.

Use authenticated MCP requests against an operator-configured endpoint. Resolve a project, read bounded work context, preserve canonical versus proposed provenance, then capture progress with a stable idempotency key. Never put private project records into the public repository or CI logs.

## Correlating a Remote Control job

Reserve the run before starting the executor. The reserved `inputHash` must be
Remote Control's canonical **job input** hash, not a hash of a deployment plan or
higher-level intent. Use the same exact command, working directory and environment
in the reservation calculation and the subsequent `job_start` call.

```js
import { createHash } from 'node:crypto';

function jobInputHash({ command, cwd, env }) {
  const entries = Object.entries(env ?? {})
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const environment = entries
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(',');
  const canonical = `{"command":${JSON.stringify(command)},"cwd":${JSON.stringify(cwd ?? null)},"env":{${environment}}}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
```

Top-level key order is `command`, `cwd`, `env`; omitted `cwd` becomes `null` and
omitted `env` becomes `{}`. Environment keys are lexicographically ordered and
serialized directly, including integer-like keys. Preserve command whitespace
and Unicode exactly; do not append a newline or substitute ASCII-escaped JSON.
Do not include `operationKey`, device, identity, source revision, idempotency key,
lease or diagnostic scope in this hash. Scope and execution identity have their
own validation. Prefer the executor's exported `jobInputHash` when available.

After `reserve_run`, use `begin_run` and pass its current lease plus the exact
project/task/run IDs to one `job_start` with a stable executor idempotency key.
Read back the exact receipt and task run. A returned job does not by itself prove
that correlation or terminal observation succeeded. Verification remains a
separate evidence-bound operation; it does not close the task or accept reports.

If attachment fails, inspect the existing job and the reserved hash. Reconcile
that receipt with `reconcile_uncertain_run`; never start the command again to
repair correlation, rewrite historical hashes, or treat missing bounded history
as proof that execution never started.
