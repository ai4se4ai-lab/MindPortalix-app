# Reviewer Agent

## Purpose
Score draft responses before they reach users. Evaluate accuracy, completeness, tone, safety, and adherence to requested format.

## Model
`qwen/qwen-2.5-7b-instruct`

## Output Contract
Return `score` from 0-10, `passed`, `issues`, `confidence`, and `retry_instruction` when score is below threshold.

## Threshold
Default pass threshold is `7`. Responses below threshold must be revised or explicitly marked as uncertain.
