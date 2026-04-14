Revise the plan below to address the scrutiny issues. Keep what passed. Same output format as the original plan.

## User-Specified Original Task (DO NOT DIRECTLY IMPLEMENT)
> {{taskDescription}}

## Previous Plan
{{previousPlan}}

## Scrutiny Issues
{{scrutinyResults}}

## Instructions
- Fix every ISSUE in the scrutiny results.
- Keep steps that had no issues.
- Do not add scope beyond what was requested.
- Preserve the output structure from the previous plan:
  - Multi-repo: Summary, Cross-Repo Context, Per-Repo Plans (with `#### [repo-name]` sections)
  - Single-repo: Summary, Execution Plan
- For multi-repo tasks, keep each `#### [repo-name]` section self-contained. Do not reference changes in other repos' sections -- restate shared contracts inline.
