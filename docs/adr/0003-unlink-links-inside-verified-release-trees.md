# Unlink links inside verified release trees

Filesystem cleanup rejects any candidate tree that contains a link or a hardlinked file, because a link can redirect removal outside the verified root. That rule keeps every existing cleaner safe, but it makes releases installed by a package manager impossible to clean. A Vite+ release is a pnpm install, so its `node_modules` holds directory junctions into the virtual store and files hardlinked from the shared content store.

A cleaner can opt in with `unlinkTreeLinks`. The candidate itself must still be an unlinked entry inside its allowed root. Below it, measurement and removal look at each entry without resolving it. A link is unlinked as an entry and never opened, so removal cannot reach what it points to. A hardlinked file loses only its name inside the tree, and its other names keep the content. Hardlinked files add no reclaimed bytes. Removal inspects every entry again at removal time, so a directory swapped for a link after detection is unlinked rather than followed.

The default stays strict. Only a cleaner that has verified its own release layout sets the option, and it adds its own selection, fallback, running-process, and installer-lock checks before removal.
