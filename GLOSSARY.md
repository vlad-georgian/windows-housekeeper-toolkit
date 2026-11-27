# windows-housekeeper-toolkit

A Windows CLI for reclaiming disk space and controlling when selected applications start or update.

## Language

**Cleanup candidate**

A specific file, directory, or driver package identified by a cleaner as eligible for removal while preserving active application versions, settings, and history.

**App startup preference**

The user's choice for whether a supported app may launch automatically at Windows sign-in.

**Startup preference enforcement**

An optional sign-in action that reapplies saved app startup preferences.

**Sign-in cleanup**

An optional unattended cleanup run triggered when the user signs in to Windows.

**Background update**

An application update that can run while the app is closed.

**Data migration**

A reversible move of eligible application files to another drive that preserves the app's ability to use them.

**Protected data**

Worktrees, project files, conversations, generated outputs, and other user state that stays in its original location during cleanup and migration.
