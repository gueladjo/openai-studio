# Claude Code Guidance

Read and follow [AGENTS.md](AGENTS.md) before working in this repository. It is
the canonical source for architecture, ownership, invariants, command safety,
and verification. Do not maintain parallel copies of that guidance here.

Claude Code requires no repository-specific compatibility overrides. Use the
commands and narrow task-to-module/test map in [AGENTS.md](AGENTS.md), preserve
unrelated worktree changes, and request explicit authorization before running
any command there classified as stateful.

Compatibility note: workspace transfer now uses verified ZIP archives and
immutable local generations. Do not reintroduce the retired JSON export or
per-file `.bak` recovery path; start backup-related work from the generation,
archive, scheduler, destination, and Electron file modules listed in
[AGENTS.md](AGENTS.md).
