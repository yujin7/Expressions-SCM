---
name: parallel-sessions
description: Protect shared Git, worktree, dev-server, PGlite, test, and commit state when concurrent agents or people may be working. Use before staging, committing, stashing, merging, starting/stopping servers, opening a shared database, quoting changing results, or when files change unexpectedly.
---

# Parallel Sessions

Assume external state can change after every observation.

1. Recheck `git log --oneline -5` and `git status --short -uall`.
2. Attribute every changed path; preserve unknown and unrelated work.
3. Prefer a dedicated branch/worktree via `npm run dev:session -- <name>`.
4. Isolate `.next`, port, database path, and background jobs.
5. Control only processes and artifacts this session created.
6. Stage explicit paths, inspect the staged diff, then recheck status immediately before commit.
7. Before merge or publication, refresh both source and target tips and rerun the evidence affected by rebasing.

Do not use `git add .`, broad stash/reset/clean commands, shared `.data/dev`, or guessed process termination in a concurrent repository.
