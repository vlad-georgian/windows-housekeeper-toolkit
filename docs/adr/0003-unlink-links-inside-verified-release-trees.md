# Unlink links inside verified release trees

Filesystem cleanup rejects any candidate tree that contains a link or a hardlinked file, because a link can redirect removal outside the verified root. That rule keeps every existing cleaner safe, but it makes releases installed by a package manager impossible to clean. A Vite+ release is a pnpm install, so its `node_modules` holds directory junctions into the virtual store and files hardlinked from the shared content store.

A cleaner can opt in with `unlinkTreeLinks`. The candidate itself must still be an unlinked entry inside its allowed root. Measurement reads each entry below it without resolving links. A link counts as one entry, and a hardlinked file adds no reclaimed bytes because its other names keep the content.

Removal does not delete by path. Node and Bun only delete by path, so checking a directory and then deleting its children by name can be redirected if another process replaces that directory with a junction in between. Instead, `anchored-delete.ts` opens each entry itself through the Windows API without following it if it is a link, asks Windows where the opened object really is, and deletes through that same handle only when it sits directly inside the parent location already verified. A directory replaced during the walk makes the next entry resolve elsewhere, and removal stops without touching it. A link is deleted as an entry and its target is never opened.

Limits that remain:

- The object that was checked is the object that is deleted, but another process can still rename it between the check and the deletion. It is then deleted at its new location. It was inside the verified tree when checked, so nothing that was outside the tree is removed.
- Handle-anchored deletion needs Windows 10 1809 or later. Where the Windows API cannot be loaded, a candidate that sets `unlinkTreeLinks` fails to remove instead of falling back to path deletion.

The default stays strict. Only a cleaner that has verified its own release layout sets the option, and it adds its own selection, fallback, running-process, and installer-lock checks before removal.
