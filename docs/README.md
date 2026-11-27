# Project documentation

Start with the [CLI usage guide](../README.md) to install and run the project.

| Path                                             | Contents                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`src/`](architecture/README.md)                 | CLI entry point, cleanup workflows, cleaner catalog, shared utilities, and Windows integrations.                                                 |
| [`docs/architecture/`](architecture/README.md)   | Runtime flow and a guide to every source module.                                                                                                 |
| [`docs/dependencies/`](dependencies/README.md)   | Direct dependencies, their roles, and tradeoffs.                                                                                                 |
| [`docs/specs/`](specs/george-windows-cleanup.md) | Implementation spec for cleanup, app controls, sign-in, and application relocation.                                                              |
| [`docs/adr/`](adr/)                              | Architecture decisions, including [application relocation with directory junctions](adr/0002-relocate-applications-with-directory-junctions.md). |
| `logs/`                                          | Generated manual-run JSON Lines audit logs. Each file records one session and is named `windows-housekeeper-toolkit-<timestamp>-<pid>.log`.      |
| `node_modules/`                                  | Packages installed from the lockfile, including the local Vite+ toolchain.                                                                       |
| [`README.md`](../README.md)                      | Installation, command examples, and development checks.                                                                                          |
| [`GLOSSARY.md`](../GLOSSARY.md)                  | Domain terms used by the CLI and implementation spec.                                                                                            |
| [`package.json`](../package.json)                | Package metadata, executable path, scripts, pinned Bun version, and direct dependencies.                                                         |
| [`bun.lock`](../bun.lock)                        | Bun's generated dependency resolution lockfile.                                                                                                  |
| [`vite.config.ts`](../vite.config.ts)            | Oxfmt and Oxlint settings for `vp fmt` and `vp check`, including four-space indentation.                                                         |
| [`tsconfig.json`](../tsconfig.json)              | Strict TypeScript checking and Bun type declarations.                                                                                            |
| [`.editorconfig`](../.editorconfig)              | Four-space indentation and newline settings for supporting editors.                                                                              |
| [`.gitignore`](../.gitignore)                    | Ignore rules for installed packages, generated logs, and OS metadata.                                                                            |
