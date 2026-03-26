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
- Each repo is a subdirectory: `./<repo-name>/path/to/file`.
- Match each repo's existing code style.
- Do NOT run lint, test, or build commands -- the orchestrator runs those after you finish.
- Do NOT commit. Just write files.
- To delete files, use `rm` via Bash.
- If the plan references review comments (`[file:line]`), address every one.
{{#if chatContext}}

## Context
{{chatContext}}
{{/if}}
