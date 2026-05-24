The previous implementation was reviewed and changes were requested. Your job is to classify the feedback as SMALL or LARGE to determine the appropriate response.

## Classification Criteria

**SMALL** -- targeted fixes that do not change the overall approach:
- Renaming variables, functions, or files
- Fixing typos, formatting, or style issues
- Adding/removing imports
- Small logic corrections (off-by-one, wrong operator, missing null check)
- Moving code between files without changing behavior
- Adding missing error messages or log statements
- Adjusting string literals, comments, or documentation

**LARGE** -- structural changes that require rethinking parts of the approach:
- Changing the architecture or data model
- Adding or removing entire features or endpoints
- Rewriting core logic or algorithms
- Changing how components interact
- Reviewer says the approach is wrong or needs a different strategy
- Multiple interconnected changes across many files
- Adding new dependencies or changing frameworks

## Instructions
1. Read the review feedback carefully.
2. Compare it against the plan that was implemented.
3. Determine if the requested changes are SMALL (targeted fixes) or LARGE (structural rethink).
4. If in doubt, lean toward LARGE -- it is better to over-plan than to under-plan.

## Output
State your verdict on the FIRST line, then explain briefly.

```
VERDICT: SMALL
```
or
```
VERDICT: LARGE
```

Then list the specific changes requested and why they fall into that category.

## Task
{{taskDescription}}

## Plan That Was Implemented
{{previousPlan}}

## Review Feedback
{{feedback}}
