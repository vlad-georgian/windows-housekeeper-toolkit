export interface ChecklistOption {
    readonly value: string
    readonly label: string
    readonly hint?: string
}

export interface TextRequest {
    readonly message: string
    readonly placeholder?: string
    readonly initialValue?: string
}

export interface ChecklistRequest {
    readonly message: string
    readonly options: readonly ChecklistOption[]
    readonly initialValues: readonly string[]
}

/** The interactive surface operations use. `null` means the user cancelled the prompt. */
export interface LaunchPrompts {
    checklist(request: ChecklistRequest): Promise<string[] | null>
    confirm(message: string): Promise<boolean | null>
    text(request: TextRequest): Promise<string | null>
    note(title: string, lines: readonly string[]): void
    log(message: string): void
}

/** One operation's part of the combined plan. Nothing changes until `apply` runs. */
export interface PlanSection {
    readonly title: string
    readonly lines: readonly string[]
    /** Applies the section, or previews it without changes in a dry run. */
    apply(): Promise<void>
}

export const cancelled: unique symbol = Symbol('cancelled')
export type Cancelled = typeof cancelled

/**
 * A top-level launch-menu choice. `gather` asks the operation's own prompts and returns its
 * plan section, `null` when nothing was selected, or `cancelled` when a prompt was cancelled.
 */
export interface LaunchOperation {
    readonly id: string
    readonly label: string
    readonly hint?: string
    gather(prompts: LaunchPrompts): Promise<PlanSection | null | Cancelled>
}
