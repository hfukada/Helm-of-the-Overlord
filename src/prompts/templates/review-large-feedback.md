The previous implementation was reviewed and the reviewer identified structural issues that require significant changes. Create a revised plan that addresses the feedback.

## Task
{{taskDescription}}

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
{{#if knowledgeContext}}

{{knowledgeContext}}
{{/if}}

## Instructions
- The previous changes are already applied in the working directory. Read files to see current state.
- Address every point in the review feedback.
- Keep parts of the previous plan that were NOT flagged by the reviewer.
- Where the reviewer requests structural changes, redesign that part of the approach.
- This plan will go through a scrutiny round before implementation, so focus on the high-level approach.

## Output Format

### Summary
1-3 sentences: what changed and why.

### Execution Plan
Numbered checklist with exact file paths and what each step does.
Prefix multi-repo steps with `[repo-name]`.
