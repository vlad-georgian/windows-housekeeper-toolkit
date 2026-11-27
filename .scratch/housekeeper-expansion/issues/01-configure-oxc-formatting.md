# Configure Oxc formatting and lint checks

Status: resolved
Type: task

Use the existing Vite+ configuration to set the project’s Oxc formatting conventions. Keep this change separate from the CLI expansion.

## Acceptance criteria

- Oxfmt sorts imports.
- Oxfmt uses a print width of 180 columns and single quotes where the language permits them.
- Oxfmt omits trailing commas and statement semicolons.
- Apply the formatting to the source in scope and keep the existing lint and type checks passing.
- Verify with the existing format check, lint, and type-check scripts.

## Comments

- Oxfmt options set in `vite.config.ts`: `printWidth: 180`, `singleQuote: true`, `semi: false`, `trailingComma: "none"`. `sortImports` was already enabled. A probe file confirmed it groups and sorts imports, then was deleted.
- Formatted `src/` and `vite.config.ts`. Two Markdown tables (`.scratch/housekeeper-expansion/spec.md`, `docs/agents/triage-labels.md`) were re-aligned by the new width. Whitespace only.
- Checked as formatting-only: the transpiled output of every changed `.ts` file matches `HEAD` once whitespace is normalized, and import sets and module order are unchanged. Only `vite.config.ts` differs, by the intended `fmt` settings.
