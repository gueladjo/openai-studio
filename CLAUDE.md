# Claude Code Guidance

Read and follow [AGENTS.md](AGENTS.md) before working in this repository. It is
the canonical working contract for task routing, command safety, coding rules,
verification, and the definition of done. Read
[docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for canonical architecture,
intended behavior, interfaces, invariants, failure handling, and acceptance
criteria. Use [README.md](README.md) for setup, operation, deployment, and
user-facing safety guidance.

Claude Code requires no repository-specific compatibility overrides. Use the
commands and narrow task-to-module/test map in [AGENTS.md](AGENTS.md), preserve
unrelated worktree changes, and request explicit authorization before running
any command there classified as stateful. Do not maintain parallel copies of
repository guidance in this file.
