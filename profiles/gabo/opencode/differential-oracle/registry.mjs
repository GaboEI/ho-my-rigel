/**
 * Differential oracle scenario registry.
 *
 * One module per scenario family. The harness iterates this list; the test
 * asserts the whole matrix is green and that every family is present. Adding a
 * family is a new `scenarios/<family>.mjs` plus an entry here.
 */

import { scenarios as delegation } from "./scenarios/delegation.mjs"
import { scenarios as ultrawork } from "./scenarios/ultrawork.mjs"
import { scenarios as rules } from "./scenarios/rules.mjs"
import { scenarios as recovery } from "./scenarios/recovery.mjs"
import { scenarios as permissions } from "./scenarios/permissions.mjs"
import { scenarios as fallback } from "./scenarios/fallback.mjs"
import { scenarios as compaction } from "./scenarios/compaction.mjs"
import { scenarios as skills } from "./scenarios/skills.mjs"
import { scenarios as goal } from "./scenarios/goal.mjs"
import { scenarios as integration } from "./scenarios/integration.mjs"
import { scenarios as entrypoint } from "./entrypoint/scenarios.mjs"

/** The nine families the scope requires. */
export const FAMILIES = Object.freeze([
  "delegation",
  "ultrawork",
  "rules",
  "recovery",
  "permissions",
  "fallback",
  "compaction",
  "skills",
  "goal",
])

export const scenarios = Object.freeze([
  ...delegation,
  ...ultrawork,
  ...rules,
  ...recovery,
  ...permissions,
  ...fallback,
  ...compaction,
  ...skills,
  ...goal,
  ...integration,
  ...entrypoint,
])
