# Dependency decisions

The versions below are the direct dependencies pinned in `package.json`.
The comparisons describe how each choice fits this codebase.

## Runtime packages

### `@clack/prompts` 1.7.0

Clack renders the app checkboxes, keyboard hints, cancellation, and progress
messages. Inquirer's checkbox prompt also supports multi-selection. Clack
fits this CLI because its prompt and log methods share the terminal layout,
so one library handles both. With `node:readline` the project would own key
handling, scrolling, redraws, and cancellation. [Clack prompts](https://bomb.sh/docs/clack/packages/prompts/), [Inquirer checkbox](https://github.com/SBoudrias/Inquirer.js/tree/main/packages/checkbox)

### `@optique/core` 1.2.4

Optique's `or` combinator expresses the mutually exclusive `--all` and
`--app ID` modes in the grammar. Node's `util.parseArgs` leaves that
cross-option check to the caller. Commander can declare conflicting
options, while Optique also provides the typed branch result this CLI maps
into `CliOptions`. [Optique](https://optique.dev/), [Node parseArgs](https://nodejs.org/api/util.html#utilparseargsconfig), [Commander](https://github.com/tj/commander.js)

### `@optique/run` 1.2.4

The runner executes the grammar and handles help, version requests, shell
completion, terminal output, and exit codes. The lower-level
`@optique/core/facade` lets callers wire these behaviors through callbacks.
The process runner fits because the CLI uses the built-in output and exit
behavior. [Optique runners](https://optique.dev/concepts/runners)

### `picocolors` 1.1.1

Picocolors provides the ANSI styles and color detection used for banners,
candidate lines, and status. It has zero dependencies. Chalk offers a
chainable interface and richer color options. Picocolors fits the small,
fixed palette used here. [Picocolors](https://github.com/alexeyraspopov/picocolors), [Chalk](https://github.com/chalk/chalk)

## Development packages

### `@types/bun` 1.4.0

Bun's declarations type-check `Bun.spawn`, `Bun.file`, `Bun.TOML`, and
other Bun APIs used by the executable. `@types/node` covers the
Node-compatible APIs. Bun's declarations cover the actual runtime and
avoid maintaining local declarations for its APIs. [Bun TypeScript guide](https://bun.com/docs/runtime/typescript), [Node type declarations](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node)

### `vite-plus` 1.5.1

Vite+ gives the project one command suite for installation, formatting,
linting, and type checks. It runs Oxfmt through `vp fmt` and combines Oxfmt,
Oxlint, and type checks through `vp check`. Installing these tools directly
would give each its own version pin. Vite+ keeps them on one pin and uses
`vite.config.ts` for formatting and linting. Prettier and ESLint would also
cover formatting and linting, with separate tools to install and configure.
[Vite+ format](https://viteplus.dev/guide/fmt), [Vite+ check](https://viteplus.dev/guide/check), [Prettier](https://prettier.io/docs/why-prettier), [ESLint](https://eslint.org/docs/latest/use/getting-started)

## Bun runtime and package manager

The project pins Bun 1.4.3. Bun runs the TypeScript entry point directly,
supplies subprocess and TOML APIs, and resolves packages with `bun.lock`.
A Node-based setup would require replacements for the Bun APIs and
TypeScript execution appropriate to the chosen Node version. Bun keeps
those capabilities in the pinned runtime. [Bun TypeScript guide](https://bun.com/docs/runtime/typescript), [Bun APIs](https://bun.com/docs/runtime/bun-apis)
