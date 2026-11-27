# Local Markdown issue tracker

- Keep each feature in `.scratch/<feature-slug>/`.
- Save the feature spec as `spec.md`.
- Save each implementation ticket in `issues/<NN>-<slug>.md`, starting at `01`.
- Record triage state in a `Status:` line near the top of each ticket. Use the strings in [Triage labels](triage-labels.md).
- Append discussion under `## Comments`.

When a skill says to publish to the issue tracker, create the appropriate spec or ticket file and create its parent directory as needed. To fetch a ticket, read the referenced path or resolve its number in the relevant feature directory.

## Wayfinding

- Save the map as `.scratch/<effort>/map.md` with Notes, Decisions-so-far, and Fog sections.
- Save each child ticket as `.scratch/<effort>/issues/<NN>-<slug>.md`. Put the question in the body and record its `Type:` as `research`, `prototype`, `grilling`, or `task`.
- Record dependencies in a `Blocked by: NN, NN` line. A ticket is unblocked when all listed tickets have `Status: resolved`.
- Pick the lowest-numbered open, unblocked, unclaimed ticket. Set `Status: claimed` before starting work.
- To resolve a ticket, append the result under `## Answer`, set `Status: resolved`, and add a summary and link to the map’s Decisions-so-far section.
