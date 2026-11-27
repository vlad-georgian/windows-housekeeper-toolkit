# Verify migrations before reclaiming source space

Migration uses documented app settings to redirect eligible files to an explicitly chosen drive, with protected data kept in place. A single command copies and verifies the files, records the previous setting and recovery paths, and applies the redirect before reclaiming source space. Rollback copies the latest files back and verifies them before restoring the previous setting, subject to available space.
