Apply the fix plan below to resolve CI failures. Follow each step exactly.

## Rules
- Follow the fix plan step by step.
- Minimal changes only. Do not refactor or add features.
- Do NOT run tests or builds yourself -- the orchestrator handles that.
- When making many changes to one file, use Write to rewrite the whole file rather than multiple Edit calls.
- Use Edit with `replace_all: true` for patterns that repeat.

## Fix Plan
{{fixPlan}}

## Original Errors
```
{{ciOutput}}
```
