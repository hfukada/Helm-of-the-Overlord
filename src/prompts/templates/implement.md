Implement the plan below. Follow each step exactly. Do not deviate or add unplanned work.

## Repositories
{{repoList}}

## Task
{{taskDescription}}

## Plan
{{plan}}
{{#if knowledgeContext}}

{{knowledgeContext}}
{{/if}}

## Rules
- Follow the Execution Plan step by step, in order.
- Match each repo's existing code style.
- Do NOT run lint, test, or build commands -- the orchestrator runs those after you finish.
- Do NOT commit. Just write files.
- To delete files, use `rm` via Bash.
- If the plan references review comments (`[file:line]`), address every one.
- Do NOT use `cat`, `head`, `tail`, or `sed` to read files. Always use the Read tool.

## Efficiency
- You have a limited number of tool turns. Be efficient.
- IMPORTANT: Always Read a file and Edit/Write it in the SAME turn. Do not Read in one turn and Edit in a later turn -- the Edit will fail. Combine Read + Edit calls in a single response.
- When making many small changes to a file (e.g. renaming classes, bulk find-replace), use Write to rewrite the full file in one go rather than many individual Edit calls.
- Use Edit with `replace_all: true` when replacing a pattern that appears multiple times in a file.
- Read a file once, plan all changes, then apply them in as few tool calls as possible.
- Batch related changes to the same file into a single Edit or Write call.
{{#if chatContext}}

## Context
{{chatContext}}
{{/if}}
