# Fast, safe delivery

Keep work small enough to understand, verify, and reverse. The normal inner loop is:

```bash
npm run check:fast
```

Before a pull request is ready:

```bash
npm run check:pr
```

For a production candidate:

```bash
npm run check:release
```

## Work-in-progress limits

- One active delivery slice per engineer or agent.
- At most two open implementation pull requests per product area.
- Prefer a complete vertical slice over parallel partial layers.
- New work waits when an older slice is blocked on review or verification.

## Risk-based evidence

| Change class | Minimum local evidence |
| --- | --- |
| Docs, copy, isolated read UI | Fast gate and focused visual check |
| Shared component, API read, workflow rule | Fast gate, related tests, focused browser/API check |
| Inventory, finance, identity, write path | Full PR gate, transaction/invariant tests, audit evidence |
| Schema or migration | Full PR gate, forward migration, rollback/recovery rehearsal |
| Release | Release gate and an explicit live smoke when an environment is available |

## Isolation

Use a dedicated worktree for concurrent work:

```bash
npm run dev:session -- <short-name>
```

This creates a `codex/<short-name>` branch, an isolated dev cache, database path, and port. Background jobs are off in ordinary development; use `npm run dev:jobs` only when testing them intentionally.

Never stage another session's files. Recheck `git status --short` immediately before committing.
