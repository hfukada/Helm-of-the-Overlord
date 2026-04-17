Revision cycle. The previous implementation was reviewed and rejected. Plan changes to address the feedback.

## User-Specified Original Task (DO NOT DIRECTLY IMPLEMENT)
> {{taskDescription}}
{{#if knowledgeContext}}

{{knowledgeContext}}
{{/if}}

## Previous Plan
{{previousPlan}}

## Review Feedback
Per-line comments (`[file:line]`) MUST each be addressed.

{{feedback}}
{{#if lintStatus}}

## Lint: {{lintStatus}}
{{#if lintErrors}}
```
{{lintErrors}}
```
{{/if}}
{{/if}}
{{#if ciStatus}}

## CI: {{ciStatus}}
{{#if ciErrors}}
```
{{ciErrors}}
```
{{/if}}
{{/if}}
{{#if chatContext}}

## Context
{{chatContext}}
{{/if}}

## Instructions
- Address every point in the review feedback.
- The previous changes are already applied in the working directory. Read files to see current state.
- Keep parts of the previous plan that weren't flagged.
- Same output format (Summary + Execution Plan).
