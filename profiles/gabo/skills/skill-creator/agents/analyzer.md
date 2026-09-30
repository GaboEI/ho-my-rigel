# Analyzer Agent

Analyze blind comparison results to understand WHY the winner won and generate improvement suggestions.

## Role

After the blind comparator determines a winner, the Analyzer "unblinds" the results by examining the skills and transcripts. The goal is to extract actionable insights: what made the winner better, and how can the loser be improved?

## Inputs

You receive these parameters in your prompt:

- **winner**: "A" or "B" (from blind comparison)
- **winner_skill_path**: Path to the skill that produced the winning output
- **winner_transcript_path**: Path to the execution transcript for the winner
- **loser_skill_path**: Path to the skill that produced the losing output
- **loser_transcript_path**: Path to the execution transcript for the loser
- **comparison_result_path**: Path to the blind comparator's output JSON
- **output_path**: Where to save the analysis results

## Process

### Step 1: Read Comparison Result

1. Read the blind comparison's output
2. Note the winner (A or B), the reasoning, and scores
3. Understand what the comparator valued in the winning output

### Step 2: Read Both Skills

1. Read the winner skill's SKILL.md and key referenced files
2. Read the loser skill's SKILL.md and key reference files
3. Identify structural differences:
   - Instructions clarity and specificity
   - Script/tool usage patterns
   - Example coverage
   - Edge case handling

### Step 3: Read Both Transcripts

1. Read the winner's transcript
2. Read the loser's transcript
3. Compare execution patterns:
   - How closely did each follow their skill's instructions?
   - What tools were used differently?
   - Where did the loser diverge from optimal behavior?
   - Did either encounter errors or make recovery attempts?

### Step 4: Analyze Instruction Following

For each transcript, evaluate:
- Did the agent follow the skill's explicit instructions?
- Did the agent use the skill's provided tools/scripts?
- Were there missed opportunities to leverage skill content?
- Did the agent add unnecessary steps not in the skill?

Score instruction following 1-10 and note specific issues.

### Step 5: Identify Winner Strengths

Determine what made the winner better:
- Clearer instructions that led to better behavior?
- Better scripts/tools that produced better output?
- More comprehensive examples that guided edge cases?
- Better error handling guidance?

Be specific. Quote from skills/transcripts where relevant.

### Step 6: Identify Loser Weaknesses

Determine what held the loser back:
- Ambiguous instructions that led to suboptimal choices?
- Missing tools/scripts that forced workarounds?
- Gaps in edge case coverage?
- Poor error handling that caused failures?

### Step 7: Generate Improvement Suggestions

Based on the analysis, produce actionable suggestions for improving the loser skill:
- Specific instruction changes to make
- Tools/scripts to add or modify
- Examples to include
- Edge cases to address

Prioritize by impact. Focus on changes that would have changed the outcome.

### Step 8: Write Analysis Results

Save to `{output_path}`.

## Output Format

```json
{
  "comparison_summary": {
    "winner": "A",
    "winner_skill": "path/to/winner/skill",
    "loser_skill": "path/to/loser/skill",
    "comparator_reasoning": "Brief summary of why comparator chose winner"
  },
  "winner_strengths": [
    "Clear step-by-step instructions for handling multi-page documents",
    "Included validation script that caught formatting errors"
  ],
  "loser_weaknesses": [
    "Vague instruction 'process the document appropriately' led to inconsistent behavior",
    "No script for validation, agent had to improvise"
  ],
  "instruction_following": {
    "winner": {
      "score": 9,
      "issues": ["Minor: skipped optional logging step"]
    },
    "loser": {
      "score": 6,
      "issues": [
        "Did not use the skill's formatting template",
        "Invented own approach instead of following step 3"
      ]
    }
  },
  "improvement_suggestions": [
    {
      "priority": "high",
      "category": "instructions",
      "suggestion": "Replace 'process the document appropriately' with explicit steps",
      "expected_impact": "Would eliminate ambiguity that caused inconsistent behavior"
    }
  ],
  "transcript_insights": {
    "winner_execution_pattern": "Read skill, Followed process, Used validation script",
    "loser_execution_pattern": "Read skill, Unclear approach, Tried different methods"
  }
}
```

## Categories for Suggestions

Use these categories:

| Category | Description |
|----------|-------------|
| `instructions` | Changes to the skill's prose instructions |
| `tools` | Scripts, templates, or utilities to add/modify |
| `examples` | Example inputs/outputs to include |
| `error_handling` | Guidance for handling failures |
| `structure` | Reorganization of skill content |
| `references` | External docs or resources to add |

## Priority Levels

- **high**: Would likely change the outcome of this comparison
- **medium**: Would improve quality but may not change win/loss
- **low**: Nice to have, marginal improvement

---

# Analyzing Benchmark Results

When analyzing benchmark results in opencode, the analyzer's purpose is to **surface patterns and anomalies** across multiple runs, not suggest skill improvements.

## Role

Review all benchmark run results and generate freeform notes that help the user understand the performance. Focus on patterns that aren't visible from aggregate metrics alone.

## Inputs

- **benchmark_data**: All run results with both configurations
- **skill_path**: Path to the skill being benchmarked
- **output_path**: Where to save the notes

## Process

### Step 1: Read Benchmark Data

Review all run results and the run_summary aggregates already calculated.

### Step 2: Analyze Per-Assertion Patterns

For each expectation across all runs:
- Does it always pass both? (may not differentiate the skill)
- Does it always pass with one but fail without? (skill clearly adds value)
- Is it variable? (flaky expectation or nondeterministic behavior)

### Step 3: Analyze Cross Eval Patterns

Look for patterns:
- Are certain eval types consistently harder/easier?
- Do some evals show high variance while others are stable?
- Are there surprising results?

### Step 4: Analyze Metrics Patterns

Look at time, tokens, tool_calls:
- Does the skill increase execution time?
- Is there high variance in resource usage?
- Are there outlier runs?

### Step 5: Generate Notes

Write freeform observations. Each note should:
- State a specific observation
- Be grounded in the data (not speculation)
- Help the user understand something the aggregate data doesn't show

Example notes:
- "Assertion X passes 100% in both configurations — may not differentiate skill value"
- "Eval 3 shows high variance — run 2 had an unusual failure"
- "Without-skill runs fail consistently on table extraction expectations"
- "Skill adds 13s average execution time but improves pass rate by 50%"

Save to `{output_path}` as a JSON array of strings.

## Guidelines

**DO:**
- Report what you observe in the data
- Be specific about which evals/expectations/runs you're referring to
- Note patterns that aggregate metrics hide
- Provide context that helps interpret the numbers

**DO NOT:**
- Suggest improvements to the skill (that's the next step)
- Make subjective quality judgments
- Speculate about causes without evidence
- Repeat information already in the run aggregates