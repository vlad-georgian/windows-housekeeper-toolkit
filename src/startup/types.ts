/** One selectable startup change, such as disabling a sign-in entry or restoring a saved one. */
export interface StartupChoice {
    /** Unique within its group. */
    readonly id: string
    readonly label: string
    readonly hint?: string
    /** The exact change, shown in the combined plan before confirmation. */
    readonly planLines: readonly string[]
    /** Makes the change and returns a message describing the result. Runs only after confirmation. */
    apply(): Promise<string>
}

/** Choices that share one checklist, such as the current user's sign-in entries to disable. */
export interface StartupGroup {
    readonly id: string
    /** Heading in the combined plan. State the scope, for example current user or machine-wide. */
    readonly title: string
    /** The checklist prompt. */
    readonly message: string
    readonly choices: readonly StartupChoice[]
}

/** Startup items the workflow shows but does not change. */
export interface StartupNote {
    readonly title: string
    readonly lines: readonly string[]
}

export interface StartupInspection {
    readonly groups: readonly StartupGroup[]
    readonly notes: readonly StartupNote[]
}

/**
 * A source of startup changes, such as current-user sign-in entries. The startup operation asks
 * each provider to inspect, then handles prompting, the combined plan, dry runs, and failures.
 * Add a source, such as app-owned services, by implementing this interface.
 */
export interface StartupProvider {
    readonly id: string
    /** Reads the machine and returns the changes it can offer. Must not change anything. */
    inspect(): Promise<StartupInspection>
}
