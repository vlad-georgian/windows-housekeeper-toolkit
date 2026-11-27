/** Resolves to the error a promise rejected with, or null if it resolved. */
export function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        () => null,
        (error: unknown) => error
    )
}
