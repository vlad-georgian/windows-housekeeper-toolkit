import * as p from "@clack/prompts";

import type { LaunchPrompts } from "./types.ts";

/** Clack-backed prompts. Checklists accept an empty selection and support A to toggle all. */
export const clackPrompts: LaunchPrompts = {
    async checklist({ message, options, initialValues }) {
        const answer = await p.multiselect({
            message,
            options: options.map((option) => ({ ...option })),
            initialValues: [...initialValues],
            required: false,
        });
        return p.isCancel(answer) ? null : answer;
    },
    async confirm(message) {
        const answer = await p.confirm({ message, initialValue: false });
        return p.isCancel(answer) ? null : answer;
    },
    note(title, lines) {
        p.note(lines.join("\n"), title);
    },
    log(message) {
        p.log.info(message);
    },
};
