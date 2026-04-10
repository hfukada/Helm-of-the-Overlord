CI/tests failed. Analyze the errors below and produce a detailed fix plan.

## CI Output
```
{{ciOutput}}
```

## Instructions
1. Read the error output carefully. Identify every distinct failure (there may be multiple).
2. For each failure, read the relevant source file(s) to understand the context.
3. Determine the root cause -- common causes:
   - Logic error (wrong condition, off-by-one, missing null check)
   - Missing or wrong import
   - Type mismatch
   - Missing dependency or command not available in environment
   - Test expectation doesn't match implementation
   - Environment issue (wrong path, missing env var, container config)
4. Produce a fix plan with exact file paths and what to change.

CRITICAL: Be specific. "Fix the test" is not a plan. "In `src/foo.test.ts` line 42, change `expect(result).toBe(3)` to `expect(result).toBe(4)` because the function now returns count+1" is a plan.

Group ALL changes to the same file into ONE step.

## Output Format

### Root Cause
What went wrong and why. Be specific about each failure.

### Fix Plan
Numbered steps. Each step: exact file path, what to change (with line references or code snippets), and why.
