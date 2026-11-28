# Unlink links inside verified release trees

Filesystem cleanup rejects any candidate tree that contains a link or a hardlinked file, because a link can redirect removal outside the verified root. That rule keeps every existing cleaner safe, but it makes releases installed by a package manager impossible to clean. A Vite+ release is a pnpm install, so its `node_modules` holds directory junctions into the virtual store and files hardlinked from the shared content store.

A cleaner can opt in with `unlinkTreeLinks`. The candidate itself must still be an unlinked entry inside its allowed root. Measurement reads each entry below it without resolving links. A link counts as one entry, and a hardlinked file adds no reclaimed bytes because its other names keep the content.

## Removal is anchored to pinned handles

Node and Bun only delete by path. Checking a directory and then deleting its children by name can be redirected if another process replaces that directory in between, with a junction or with a different plain directory. Removal of an opted-in candidate therefore never deletes by path. `anchored-delete.ts` does the following:

- It opens the root without following links and requires it to be the object detected earlier: the same volume serial and file index, at the verified canonical location. A different directory moved into the same name is refused.
- It keeps a handle open on every directory from the root down to the one being emptied. Those handles are opened without delete sharing, so Windows refuses to rename, replace, or delete any of them, or their ancestors, until the walk ends. The same holds for each file or link between its check and its deletion.
- It opens each child by name, without following it if it is a link, and requires Windows to report it directly inside its parent's verified location.
- It deletes each entry through the handle that was just verified, never by name. A link is deleted as an entry and its target is never opened.

A directory therefore cannot be swapped, by junction or by another plain directory, between its check and its removal, and a checked entry cannot be renamed out of the tree and then deleted elsewhere. The tests rename the directory being emptied and a parent mid-walk and confirm Windows refuses.

Unsupported, and refused rather than approximated:

- Windows older than 10 1809, or any case where the Windows API cannot be loaded. A candidate that sets `unlinkTreeLinks` fails to remove and never falls back to path deletion.
- An entry that another process holds open with sharing that conflicts with ours. The removal fails and leaves the rest of the tree.
- A failed removal can leave a partly emptied release. It no longer verifies as a release, so it is not offered again.

The default stays strict. Only a cleaner that has verified its own release layout sets the option, and it adds its own selection, fallback, running-process, and installer-lock checks. The Vite+ cleaner holds the installer's lock for the whole read-and-remove sequence. It pins the canonical store directory and the lock file the same way, takes the lock without waiting, and works only for Vite+ 1.7.0 and later, whose updater and rollback take that lock. Earlier releases roll back with no lock, so nothing can keep a rollback from swapping `current`, and the cleaner offers nothing for them.

While it holds the lock, the cleaner also treats a running process or runtime command line that names the store's `current` link, by any spelling, as making the whole store ambiguous. A process started before an update keeps loading files from the old release while naming only the link, so nothing in that store is offered or removed until it exits.
