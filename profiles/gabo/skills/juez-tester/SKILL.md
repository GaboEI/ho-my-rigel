---
name: juez-tester
description: Use only when a user clearly asks to diagnose and correct a problem, or an executing agent explicitly invokes this skill to self-audit completed work. It validates evidence, fixes correctable findings, and returns SELF_AUDIT_PASS only when ready for independent review. Do not use for audit-only requests or final acceptance audits.
license: Personal
metadata:
  hermes:
    tags: [self-audit, testing, security, quality-control, code-review]
    related_skills: []
---

# juez-tester

## Activation gate

Activate this skill only when one of these conditions is true:

- The user clearly asks both to diagnose and to correct or solve a problem, for example: "audit and fix", "review, find the problem, and solve it", or "test this and correct what fails".
- An executing agent explicitly invokes `juez-tester`, including through its standing completion workflow.

Do not activate it for an audit-only, diagnosis-only, review-only, or test-only request. In those cases, inspect and report normally without entering the self-correction loop. A request to independently accept, reject, or validate another agent's work belongs to the Judge agent.

## Purpose and boundary

This skill is an executing agent's internal quality gate. Use it after completing work and before returning that work to a user, maintainer, or independent Judge.

It is deliberately not an independent acceptance audit. The agent is auditing its own work, so it must compensate for that bias by trying to disprove its own claims. It never issues `APPROVED`, changes task status, certifies closure, or replaces an independent Judge.

`SELF_AUDIT_PASS` means only that the executing agent found no remaining blocker after completing the checks appropriate to the real risk. It is not final acceptance.

This skill is general: apply the task's actual contract, environment limits, and applicable standards without assuming any product, repository, agent name, or workflow.

## Inputs and authority

Reconstruct from the task and available artifacts:

- objective, scope, exclusions, and acceptance criteria;
- affected artifacts and baseline;
- applicable standards, permissions, and environment constraints;
- claims the agent intends to make on completion.

Do not invent acceptance criteria or relax existing ones. The executing agent may inspect and correct artifacts within the already authorized task scope. This skill does not itself authorize commits, pushes, deployments, destructive actions, external changes, or scope expansion.

## Self-audit loop

Repeat this loop until it passes or a real maintainer decision is necessary:

1. **Establish the real contract and risk.** Classify the impact as `TRIVIAL`, `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`. Consider reversibility, security, data, network, production exposure, public consumers, and the consequence of being wrong.
2. **Try to disprove completion.** Inspect the complete relevant diff or artifact, not only the files the agent remembers changing. Verify requirements against observable behavior and evidence.
3. **Run proportional checks.** Use relevant official tests and validators, then add adversarial checks for the real risks. Consider functional paths, invalid input, failure and recovery, state consistency, regression, integration, security/privacy, resources, and operational documentation only where applicable.
4. **Correct every correctable finding.** A bug, missing validation, weak test, misleading documentation, regression, or incomplete cleanup is not a reportable self-rejection: fix it within scope, then re-run the affected and regression checks.
5. **Reassess after each correction.** A passing narrow test does not prove an unchanged surrounding system. Re-run the checks needed to support the final claim.

For `MEDIUM`, `HIGH`, and `CRITICAL` work, an essential unverified requirement prevents `SELF_AUDIT_PASS`. For `TRIVIAL` and `LOW` work, keep the audit proportionate but still verify the changed behavior and direct regressions.

## Evidence discipline

- Treat the agent's own intent, implementation, test result, or previous reasoning as a claim to verify, not proof by itself.
- Verify the relevant version, artifact, branch, document, or environment before drawing conclusions.
- A green suite proves only what it covers. Check skips, excluded paths, weak assertions, unrealistic fixtures, and untested failure paths when they matter.
- Documentation, configuration, examples, and operational instructions must describe the resulting behavior when they are in scope.
- Preserve a clear distinction between verified, not applicable, and not verified. Never convert uncertainty into a pass.
- Keep validation safe and proportional. Use isolated, reversible environments for stateful tests when available. Do not make dangerous or irreversible external changes just to obtain a green result.

## Findings and escalation

Do not return `SELF_AUDIT_REJECTED`. A correctable failure stays inside the loop: correct it and audit again.

Return `SELF_AUDIT_BLOCKED` only when progress requires something the executing agent cannot safely decide or obtain, such as a genuine maintainer decision, missing authorization, indispensable unavailable access, or a safety boundary. Do not escalate routine implementation errors, missing tests, or documentation defects that can be fixed within scope.

If OpenCode and the active model support subagents, one may assist with a bounded verification or adversarial check when it materially improves confidence. It is optional, may not replace the executing agent's responsibility, and does not authorize extra work.

## Output contract

During the correction loop, do not emit a formal audit report, a rejection report, or a long matrix.

When the work passes, return a concise normal completion summary prefixed exactly as follows:

```markdown
SELF_AUDIT_PASS

- Result: <what now works or was completed>
- Corrections during self-audit: <none, or concise list>
- Validation: <commands/checks and their outcome>
- Limits: <none, or facts that do not invalidate the completed scope>
```

This summary may be incorporated into the normal task report. It must not use `APPROVED`, claim independent acceptance, or change any task state.

When a maintainer decision is indispensable, return only this compact escalation:

```markdown
SELF_AUDIT_BLOCKED

- Decision or access required: <exact need>
- Why it cannot be safely corrected within scope: <evidence-based reason>
- Minimal options: <only viable choices, if known>
- Evidence: <paths, commands, errors, or observable facts>
```

After the decision or access arrives, resume the self-audit loop. Do not treat the block as a pass.

