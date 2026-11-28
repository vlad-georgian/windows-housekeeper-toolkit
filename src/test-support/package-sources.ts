import type { PackageSources } from '../relocation/apps/package-evidence.ts'

/** Package-manager sources for tests that must not read the machine's environment. */
export const isolatedPackageSources: PackageSources = { env: {}, machineChocolatey: async () => undefined }
