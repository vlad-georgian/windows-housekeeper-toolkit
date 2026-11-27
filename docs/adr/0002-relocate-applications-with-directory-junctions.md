# Relocate applications with directory junctions

An application can own several per-user installation and data directories, including directories that offer no app setting for changing their location. Relocation groups those directories by application, mirrors their paths under the user-selected base directory and profile name, and keeps the original directory paths accessible through junctions. The toolkit verifies the copy and each junction before reclaiming source space. Reversal brings the latest files back and verifies the restored directories before reclaiming destination space.

The selection marks an application as migrated only when all its configured paths link to their mirrored destinations under the chosen base. Clearing that selection requests reversal. When an application has a mix of local paths and links, relocation records each link and its verified target, moves the in-scope data into the chosen layout, and replaces the old links. Verification and recovery records precede any link replacement.

This design supersedes the app-setting-based migration in [ADR 0001](0001-verify-migrations-before-reclaiming-source-space.md).
