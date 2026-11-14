# Agent Desktop runtime

The runtime owns native MCP clients, a private native session, refs, and current calls for each
trusted broker session/workspace identity. The existing broker remains the authority for the
context and token ledger. Only a local main agent on the continuous desktop delivery path may
execute; remote identities, remote session IDs, replayable delivery, and subagents fail closed.
The host injects the shared remote-identity parser. Without it nonempty identities are denied.

`desktop_tools` exposes a fixed safe subset of the pinned native schemas. `desktop_call` validates
the tool and arguments, then returns the original MCP result with additive error delivery receipts.
Each call starts a bounded MCP client and terminates it before returning. An explicit `--headed`
client uses the same native session as background calls, preserving refs in the native ref store.
Model arguments cannot change native globals or select arbitrary file output paths. No shell,
sandbox, trace, session administration, process argument, or held-input tools are exposed.

Native session creation explicitly disables trace. No initialization or permission query takes
a screenshot. A fixed loopback TCP listener, derived from the current OS user's identity,
is the cross-process desktop lease: it accepts no data and destroys incoming sockets. A busy
port rejects immediately, without queuing; process death automatically releases the OS lease.
Only the current call owns and releases the listener. Tests can inject a private lock port via
the trusted host environment without changing the desktop action contract.

Cancellation, stop, closeSession, and dispose terminate controlled process trees, discard refs,
and remove the private native session directory. Transport errors after submission report
`possibly_sent` and never retry an action. Initialization, command execution, transport output,
and cleanup are bounded. The runtime uses only an absolute host-injected native binary;
it never searches PATH or downloads executable code.

Inactive session refs expire after ten minutes, and at most sixteen inactive ref namespaces
are retained. An unref timer only removes idle resources; it never schedules desktop operations.
A subsequent call after expiry creates a new native namespace, so old refs fail and the agent
must observe again. The cache holds no native process, accepted queue, or application session truth.
