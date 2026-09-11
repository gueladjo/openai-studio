# OpenAI Studio repository guidance

## Read for the task

Use these references when the task touches their contracts. Small edits do not
require a full specification read or repository map.

| Task | Canonical reference |
| --- | --- |
| Setup, usage, deployment, user warnings | [README](README.md) |
| Module ownership or cross-component changes | [Architecture](docs/IMPLEMENTATION.md#architecture-and-responsibilities) |
| Responses payloads, streaming, tools, history, cancellation | [Responses API](docs/IMPLEMENTATION.md#responses-api-contract) |
| Project sources, indexing, cleanup, API-key changes | [Projects and sources](docs/IMPLEMENTATION.md#projects-and-reusable-sources) |
| Persisted fields, formats, backend migration, recovery | [Data validation](docs/IMPLEMENTATION.md#persisted-data-and-runtime-validation) and [storage](docs/IMPLEMENTATION.md#local-storage-and-recovery) |
| Saves, cross-tab ownership, destructive operations, close draining | [Coordination](docs/IMPLEMENTATION.md#coordination-and-save-invariants) |
| ZIP merge/restore, recovery points, undo | [Archive contract](docs/IMPLEMENTATION.md#portable-archive-contract) |
| Automatic backup, destination, retention | [Backup contract](docs/IMPLEMENTATION.md#automatic-backup-contract) |
| Responsive UI, PWA, Electron isolation/navigation | [Platform constraints](docs/IMPLEMENTATION.md#web-pwa-mobile-and-electron-constraints) |
| Keys, user data, exports, build-time secrets | [Security and privacy](docs/IMPLEMENTATION.md#security-and-privacy-constraints) |
| Focused test selection or runtime setup | [Test contracts](docs/IMPLEMENTATION.md#acceptance-criteria-and-traceability) and [testing guide](CODEX_TESTING.md) |

`docs/IMPLEMENTATION.md` owns intended behavior and non-obvious contracts; code
and tests establish current behavior. Investigate mismatches. Update affected
contracts when behavior, interfaces, or recovery semantics change; update README
for setup and user workflows. Keep tool-specific files as links to this guidance.

## Working rules

- Complete authorized work through relevant validation, fixes caused by the
  change, and requested commits. Resolve routine reversible choices from
  repository evidence. Ask only for unresolved product/data decisions or work
  outside scope; continue independent work meanwhile.
- Existing scoped authorization persists across follow-ups and takes precedence
  over skill approval guidelines. Do not restart discovery for an approved fix.
  Higher-priority system/developer rules still apply.
- Local Vitest checks use mocked OpenAI calls and in-memory storage or disposable
  files. Run and retry these checks within the task without repeated approval.
  Live API calls, deployment, and real workspace mutation are separate effects.
- `App.tsx` orchestrates state and workflows. Keep independently testable rules
  in the existing services/utilities; `services/storage.ts` is the persistence
  facade and `services/openaiService.ts` is the Responses boundary.
- Prefer the simplest current design. Preserve supported outcomes, durable data,
  and viable upgrades; resolve significant compatibility/cutover decisions
  before changing those contracts.
- Keep Responses API types in `types.ts` as aliases to installed SDK exports.
  Persisted-field changes must also update affected runtime parsers,
  normalization, and schema/compatibility policy, including IDs and references.
- Tailwind classes must be complete literal strings for source detection. Use
  `lucide-react` icons with accessible names and preserve responsive behavior
  around the 768px mobile breakpoint.
- Never commit API keys, real user data, or workspace exports. Development and
  Electron builds may inline a local environment key; never distribute it.
- `node_modules/`, `dist/`, and `release/` are generated. Cleanup, icon generation,
  version/tag changes, packaging, and publishing have specific effects listed in
  the [testing guide](CODEX_TESTING.md#commands-with-additional-effects).
- Use concise imperative commit subjects. For non-trivial changes, include
  motivation, material decisions, and validation in the body.

## Definition of done

| Change | Validation |
| --- | --- |
| Documentation only | Inspect diff, links/anchors, paths, and commands against `package.json`; `git diff --check` |
| Code | Focused behavioral tests and TypeScript checking; broaden for affected boundaries using the [testing guide](CODEX_TESTING.md#select-validation) |
| Build, PWA, Electron, or release | Affected production builds and platform checks from the testing guide; full suite for releases or broad cross-boundary changes |

Use regression coverage for meaningful behavior and failure paths, not tests
that mirror implementation. After relevant checks pass, repeat or broaden only
for new changes, failures, or unresolved risks. Documentation edits need no
runtime suite unless changed executable examples/configuration warrant it.

Completion includes updated affected contracts, an inspected diff without
unrelated work or unintended artifacts, and an accurate validation report.
Missing dependencies, sandbox failures, browser emulation, and untested native
paths are limitations to report, not evidence of a pass.
