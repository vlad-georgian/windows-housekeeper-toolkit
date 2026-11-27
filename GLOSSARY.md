# windows-housekeeper-toolkit

A Windows CLI for reclaiming disk space and controlling when selected applications start or update.

## Language

**Cleanup candidate**

A specific file, directory, or driver package identified by a cleaner as eligible for removal while preserving active application versions, settings, and history.

**General cache cleanup**

Removal of regenerable application data that leaves ordinary application use intact.

**Destructive cache cleanup**

Removal of rebuildable stores whose absence can require redownloads or prevent offline use.

**Superseded installation**

An installed release replaced within its own release channel. A selected release in one channel remains active even if another channel has a higher version number.

**App startup preference**

The user's choice for whether a supported app may launch automatically at Windows sign-in.

**App service startup preference**

The user's choice for whether a supported app-owned Windows service may start automatically.

**Startup preference enforcement**

An optional sign-in action that reapplies saved app startup preferences.

**Sign-in cleanup**

An optional unattended cleanup run triggered when the user signs in to Windows.

**Background update**

An application update that can run while the app is closed.

**Application relocation**

A reversible move of a supported application's installation and data directories to another drive while keeping them accessible at their original paths.

**Migrated application**

A supported application whose configured paths all resolve through links to their destinations under the chosen relocation base.

**Protected data**

Worktrees, project files, conversations, generated outputs, credentials, and other user state excluded from cleanup.
