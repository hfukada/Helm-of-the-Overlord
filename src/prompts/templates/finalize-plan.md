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
- Same output format (Summary + Execution Plan).

## Efficiency constraint
The implementation agent has a LIMITED number of tool turns (~30). Structure the plan to minimize tool calls:
- Group ALL changes to the same file into ONE step. Never list the same file in multiple steps.
- For bulk find-replace tasks (e.g. renaming a CSS class across a file), say "rewrite the file with these replacements" rather than listing each replacement individually.
- Prefer "replace all occurrences of X with Y" over listing each line number.
- If more than ~5 color/class/name changes in a file, instruct the agent to Write the full file contents rather than making individual edits.
