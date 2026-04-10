Final pass. Address remaining scrutiny issues and add implementation detail so the plan can be followed mechanically.

## Task
{{taskDescription}}

## Current Plan
{{previousPlan}}

## Final Scrutiny
{{scrutinyResults}}

## Instructions
- Fix any remaining issues from scrutiny.
- For each step, include: the file, what changes, and function signatures/types where applicable.
- If modifying existing code, quote the relevant line(s) being changed.
- The implementation agent follows this plan exactly. No design decisions should be left to it.
- Do NOT explore the codebase. Refine the existing plan text.

## Output Format

### Summary
1-3 sentences: overall goal and approach.

### Cross-Repo Context
(Only include this section if the task spans multiple repos.)
Brief description of how the repos interact for this task -- what APIs/contracts are shared, order of changes, etc. Keep it short. This is shared context every child will see.

### Per-Repo Plans
(Use this structure ONLY if the task spans multiple repos. For single-repo tasks, use a single "### Execution Plan" section instead.)

For each affected repo, produce a dedicated section:

#### [repo-name]

A focused implementation plan for THIS repo only. Include:
- A 1-2 sentence summary of what this repo does in this task
- Numbered steps with exact file paths and changes
- Function signatures, types, quoted lines where relevant

The child task runner will execute each `#### [repo-name]` section INDEPENDENTLY. Do NOT reference changes in other repos' sections by step number or file path -- each section must stand alone. If a repo needs to know about another repo's contract (e.g. API shape), restate it inline in this section's context.

### Execution Plan
(Single-repo tasks only. Same as before: numbered checklist with file paths and changes.)

## Efficiency constraint
The implementation agent has a LIMITED number of tool turns (~30 per repo). Structure each per-repo plan to minimize tool calls:
- Group ALL changes to the same file into ONE step. Never list the same file in multiple steps within a repo's section.
- For bulk find-replace tasks, say "rewrite the file with these replacements" rather than listing each replacement individually.
- Prefer "replace all occurrences of X with Y" over listing each line number.
- If more than ~5 changes in a file, instruct the agent to Write the full file contents rather than making individual edits.
