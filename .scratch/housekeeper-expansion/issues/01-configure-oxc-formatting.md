# Configure Oxc formatting and lint checks

Status: needs-triage
Type: task

Use the existing Vite+ configuration to set the project’s Oxc formatting conventions. Keep this change separate from the CLI expansion.

## Acceptance criteria

- Oxfmt sorts imports.
- Oxfmt uses a print width of 180 columns and single quotes where the language permits them.
- Oxfmt omits trailing commas and statement semicolons.
- Apply the formatting to the source in scope and keep the existing lint and type checks passing.
- Verify with the existing format check, lint, and type-check scripts.
