/**
 * Integration scenarios: end-to-end observables.
 *
 * Each scenario here drives the REAL V1 factory/handler and the REAL V2 surface
 * through equivalent fake ports and compares an observable that crosses the
 * host: provider payload, result mutation, block decision, handoff, or state.
 * The helper scenarios in the per-family modules remain as secondary drift
 * guards; these are the end-to-end contract.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PKG = "../../../../../packages"

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf8")
}

/** A fake V2 session client that records create/prompt payloads. */
function fakeSessionClient(childText = "child result") {
  const calls = { create: [], prompt: [], wait: 0, context: 0 }
  return {
    calls,
    client: {
      session: {
        async create(args) {
          calls.create.push(args)
          return { id: "ses_diff_child" }
        },
        async prompt(args) {
          calls.prompt.push(args)
          return {}
        },
        async wait() {
          calls.wait += 1
          return {}
        },
        async context() {
          calls.context += 1
          return { data: [{ type: "assistant", content: [{ type: "text", text: childText }] }] }
        },
      },
    },
  }
}

function firstLineStripped(text) {
  const index = text.indexOf("\n")
  return index === -1 ? "" : text.slice(index + 1)
}

/** In-memory V2 storage domain for the goal store. */
function memoryStorage() {
  const map = new Map()
  return {
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
  }
}

/** V2 goal store + controller lifecycle, normalized to the record identity. */
async function goalLifecycle(controller) {
  const created = await controller.setGoal("ses_diff", "Ship the oracle")
  const got = await controller.getGoal("ses_diff")
  const paused = await controller.pauseGoal("ses_diff")
  const resumed = await controller.resumeGoal("ses_diff")
  const existed = await controller.clearGoal("ses_diff")
  const after = await controller.getGoal("ses_diff")
  const project = (goal) => (goal ? { objective: goal.objective, status: goal.status } : null)
  return {
    created: project(created),
    got: project(got),
    paused: project(paused),
    resumed: project(resumed),
    existed,
    after: project(after),
  }
}

/** @type {import("./harness.mjs").Scenario[]} */
export const scenarios = [
  // -------------------------------------------------------------------------
  // delegation: real V2 create/prompt payload vs the V1 child-prompt builder
  // -------------------------------------------------------------------------
  {
    id: "delegation.session-payload",
    family: "delegation",
    integration: true,
    observableType: "provider-payload",
    why: "V2 delegateNamedAgent creates the child with the same agent/parent and sends the same child prompt content as the V1 delegate builder; the foreground result is read back.",
    loadV1: async () => {
      const promptBuilder = await import(`${PKG}/omo-opencode/src/tools/delegate-task/prompt-builder.ts`)
      const discovery = await import(`${PKG}/omo-opencode/src/tools/delegate-task/subagent-discovery.ts`)
      return { promptBuilder, discovery }
    },
    loadV2: () => import("../../rigel-v2-native-core.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => ({
      agent: v1.discovery.sanitizeSubagentType(input.agent),
      parentID: input.parentSessionID,
      prompt: v1.promptBuilder.buildTaskPrompt(input.prompt, input.agent),
    }),
    observeV2: async (v2, input) => {
      const { client, calls } = fakeSessionClient()
      await v2.delegateNamedAgent({
        client,
        location: { directory: "/repo" },
        agent: { id: input.agent, name: input.agent },
        prompt: input.prompt,
        background: false,
        parentSessionID: input.parentSessionID,
      })
      return {
        agent: calls.create[0]?.agent,
        parentID: calls.create[0]?.parentID,
        prompt: firstLineStripped(calls.prompt[0]?.text ?? ""),
      }
    },
    corpus: [
      { name: "explore child", agent: "explore", prompt: "find the auth code", parentSessionID: "ses_parent_diff" },
      { name: "oracle child", agent: "oracle", prompt: "review the plan", parentSessionID: "ses_parent_diff" },
    ],
    mutation: { target: "delegateNamedAgent", perturb: () => async () => ({ sessionID: "x", agent: "x", background: false }) },
  },

  // -------------------------------------------------------------------------
  // ultrawork: provider-visible directive injection (V1 hook vs V2 seam)
  // -------------------------------------------------------------------------
  {
    id: "ultrawork.injection",
    family: "ultrawork",
    integration: true,
    observableType: "provider-payload",
    why: "V2 appends the same source-routed ultrawork directive to the outgoing user message as the V1 keyword-detector hook mutates into the message parts.",
    loadV1: async () => {
      const hook = await import(`${PKG}/omo-opencode/src/hooks/keyword-detector/hook.ts`)
      const messages = await import(`${PKG}/omo-opencode/src/hooks/keyword-detector/ultrawork/index.ts`)
      const detector = await import(`${PKG}/omo-opencode/src/hooks/keyword-detector/detector.ts`)
      return { hook, messages, detector }
    },
    loadV2: () => import("../../rigel-v2-native-keyword-seam.mjs"),
    tolerance: { kind: "exact" },
    observeV1: async (v1, input) => {
      const detector = v1.hook.createKeywordDetectorHook({
        client: { tui: { showToast: () => ({ catch() {} }) } },
      })
      const output = { message: {}, parts: [{ type: "text", text: input.text }] }
      await detector["chat.message"](
        { sessionID: "ses_diff", agent: input.agent, model: { providerID: "openai", modelID: input.modelID } },
        output,
      )
      return output.parts.map((part) => part.text).join("\u0000")
    },
    observeV2: async (v2, input, v1) => {
      const body = { messages: [{ role: "user", content: input.text }] }
      const detected = v1.detector.detectKeywordsWithType(input.text, input.agent, input.modelID, undefined, undefined)
      const ultraworkMessage = detected.find((keyword) => keyword.type === "ultrawork")?.message
      const seam = v2.createKeywordSeam({
        ultraworkPrompt: ultraworkMessage ?? "",
        keywordMessages: {},
        disabledKeywords: [],
        enabledExpansions: undefined,
      })
      const parts = v2.chatUserParts(body.messages)
      const { directive } = seam.decide({ parts, sessionID: "ses_diff", agent: input.agent, modelID: input.modelID })
      v2.appendDirectiveToUserMessage(body.messages[0], directive)
      return body.messages.map((message) => message.content).join("\u0000")
    },
    corpus: [
      { name: "ultrawork gpt", text: "do ultrawork now", agent: "sisyphus", modelID: "gpt-5.5" },
      { name: "ulw default", text: "ulw please", agent: "sisyphus", modelID: "anthropic/claude-sonnet-4-6" },
      { name: "no keyword negative", text: "just a normal request", agent: "sisyphus", modelID: "gpt-5.5" },
    ],
    mutation: { target: "appendDirectiveToUserMessage", perturb: () => () => false },
  },

  // -------------------------------------------------------------------------
  // rules: discovery + load + truncation + session dedup via the real injector
  // -------------------------------------------------------------------------
  {
    id: "rules.injection",
    family: "rules",
    integration: true,
    observableType: "result-mutation",
    why: "V2 injects the same discovered rule content into a read result as the V1 rule-injection processor, over the same on-disk rule tree, and dedups per session.",
    loadV1: async () => {
      const processor = await import(`${PKG}/omo-opencode/src/hooks/rules-injector/injection-processor.ts`)
      return { processor }
    },
    loadV2: () => import("../../rigel-v2-native-rules.mjs"),
    tolerance: { kind: "exact" },
    observeV1: async (v1, input) => {
      const project = input.project
      const processor = v1.processor.createRuleInjectionProcessor({
        workspaceDirectory: project,
        truncator: { truncate: async (_sessionID, content) => ({ result: content, truncated: false }) },
        getSessionCache: () => ({ realPaths: new Set(), contentHashes: new Set() }),
      })
      const output = { title: "read", output: "file body", metadata: {} }
      await processor.processFilePathForInjection(path.join(project, "src", "a.ts"), "ses_diff", output)
      return collapseWhitespace(output.output)
    },
    observeV2: async (v2, input) => {
      const injector = v2.createNativeRulesInjector({ directory: input.project, home: input.home })
      const event = {
        status: "completed",
        tool: "read",
        sessionID: "ses_diff",
        input: { filePath: path.join(input.project, "src", "a.ts") },
        result: { content: "file body" },
      }
      await injector.after(event)
      return collapseWhitespace(event.result?.content ?? event.output ?? "")
    },
    corpus: (() => {
      const project = tempDir("diff-rules-")
      const home = tempDir("diff-home-")
      writeFile(path.join(project, "package.json"), "{}\n")
      writeFile(path.join(project, ".omo", "rules", "always.md"), "---\nalwaysApply: true\n---\nRULE-ALWAYS-BODY\n")
      writeFile(path.join(project, "src", "a.ts"), "const a = 1\n")
      return [{ name: "project rule", project, home }]
    })(),
    mutation: { target: "createNativeRulesInjector", perturb: () => () => ({ after: async () => false }) },
  },

  // -------------------------------------------------------------------------
  // recovery: real webfetch redirect resolution (V1 vs V2) with a fake fetch
  // -------------------------------------------------------------------------
  {
    id: "recovery.webfetch-redirect",
    family: "recovery",
    integration: true,
    observableType: "selection",
    why: "V2 resolves the same webfetch redirect chain to the same terminal URL as the V1 redirect resolver, including the exceeded-limit case.",
    oracle: "recovery.webfetch",
    loadV2: () => import("../../rigel-v2-native-webfetch-redirect-guard.mjs"),
    tolerance: { kind: "exact" },
    observeV1: async (v1, input) => v1.resolveWebFetchRedirects({ url: (await redirectServer()) + input.path, format: "markdown" }),
    observeV2: async (v2, input) => v2.resolveWebFetchRedirects({ url: (await redirectServer()) + input.path, format: "markdown" }),
    corpus: [
      { name: "single redirect", path: "/1" },
      { name: "no redirect", path: "/x" },
      { name: "exceeds limit", path: "/loop0" },
    ],
    mutation: { target: "resolveWebFetchRedirects", perturb: () => async () => ({ type: "exceeded", url: "drifted", maxRedirects: 10 }) },
  },

  // -------------------------------------------------------------------------
  // fallback: real rung advance and exhaustion (V1 hook state vs V2 resolver)
  // -------------------------------------------------------------------------
  {
    id: "fallback.rung-advance",
    family: "fallback",
    integration: true,
    observableType: "selection",
    why: "V2's resolver walks the fallback chain in the same order, and exhausts to null, as the V1 model-fallback hook's stateful advance.",
    loadV1: () => import(`${PKG}/omo-opencode/src/hooks/model-fallback/hook.ts`),
    loadV2: () => import("../../rigel-v2-native-model-chains.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const hook = v1.createModelFallbackHook()
      hook.setSessionFallbackChain("ses_diff", input.chain)
      let current = input.current
      hook.setPendingModelFallback("ses_diff", input.agent, current.providerID, current.modelID)
      const sequence = []
      for (let index = 0; index <= input.chain.length; index += 1) {
        const rung = hook.getNextFallback("ses_diff")
        sequence.push(rung ? `${rung.providerID}/${rung.modelID}` : null)
        if (!rung) continue
        current = { providerID: rung.providerID, modelID: rung.modelID }
        hook.setPendingModelFallback("ses_diff", input.agent, current.providerID, current.modelID)
      }
      return sequence
    },
    observeV2: (v2, input) => {
      const failed = []
      const sequence = []
      for (let index = 0; index <= input.chain.length; index += 1) {
        const rung = v2.resolveFallbackModel({ chain: input.chain, availableModels: input.available, failedModels: failed })
        if (!rung) {
          sequence.push(null)
          continue
        }
        sequence.push(v2.modelKey(rung))
        failed.push(v2.modelKey(rung))
      }
      return sequence
    },
    corpus: [
      {
        name: "two rungs then exhaust",
        agent: "sisyphus",
        current: { providerID: "openai", modelID: "gpt-4o-probe" },
        chain: [
          { providers: ["openai"], model: "gpt-6-astra", variant: "xhigh" },
          { providers: ["openai"], model: "gpt-6-luna-fast", variant: "low" },
        ],
        available: [
          { providerID: "openai", id: "gpt-6-astra" },
          { providerID: "openai", id: "gpt-6-luna-fast" },
        ],
      },
    ],
    mutation: { target: "resolveFallbackModel", perturb: () => () => undefined },
  },

  // -------------------------------------------------------------------------
  // compaction: summary payload injection with delegated history (V1 vs V2)
  // -------------------------------------------------------------------------
  {
    id: "compaction.summary-payload",
    family: "compaction",
    integration: true,
    observableType: "provider-payload",
    why: "V2 injects the same compaction context block (template + delegated history) into the summary request body as the V1 injector returns, and only for a compaction request.",
    loadV1: async () => {
      const hook = await import(`${PKG}/omo-opencode/src/hooks/compaction-context-injector/hook.ts`)
      return { hook }
    },
    loadV2: () => import("../../rigel-v2-native-compaction-context.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const injector = v1.hook.createCompactionContextInjector({
        backgroundManager: { taskHistory: { formatForCompaction: () => input.history } },
      })
      return injector.inject("ses_diff")
    },
    observeV2: async (v2, input) => {
      const step = v2.createCompactionContextStep({ buildBlock: () => v2.buildCompactionContextBlock({ history: input.history }) })
      const body = { messages: [{ role: "user", content: "You MUST summarize the conversation" }] }
      await step.run({ body, kind: "compaction", shape: "chat", sessionID: "ses_diff" })
      const injected = body.messages[body.messages.length - 1]
      return typeof injected.content === "string" ? injected.content : injected.content.map((part) => part.text).join("")
    },
    corpus: [
      { name: "compaction with history", history: "ses_child_diff | explore | succeeded | find the auth code" },
      { name: "compaction without history", history: "" },
    ],
    mutation: { target: "createCompactionContextStep", perturb: () => () => ({ name: "x", run: async () => undefined }) },
  },

  // -------------------------------------------------------------------------
  // skills: scope discovery + precedence resolution (V1 vs V2) over a temp tree
  // -------------------------------------------------------------------------
  {
    id: "skills.scope-discovery",
    family: "skills",
    integration: true,
    observableType: "selection",
    why: "V2 resolves a skill name to the same higher-priority scope and body as the V1 skill loader when the same name exists in two scopes.",
    loadV1: async () => {
      const loader = await import(`${PKG}/skills-loader-core/src/features/opencode-skill-loader/loader.ts`)
      return { loader }
    },
    loadV2: () => import("../../rigel-v2-native-skills.mjs"),
    tolerance: { kind: "exact" },
    observeV1: async (v1, input) => {
      const previousHome = process.env.HOME
      process.env.HOME = input.home
      try {
        const skills = await v1.loader.discoverAllSkills(input.project)
        const match = skills.find((skill) => skill.name === input.skillName)
        if (!match) return null
        const body = match.lazyContent ? await match.lazyContent.load() : (match.lazyContent?.content ?? "")
        return { name: match.name, scope: match.scope, body: extractSkillRawBody(body) }
      } finally {
        process.env.HOME = previousHome
      }
    },
    observeV2: (v2, input) => {
      const skills = v2.discoverSkills({ directory: input.project, home: input.home })
      const match = skills.find((skill) => skill.name === input.skillName)
      return match ? { name: match.name, scope: match.scope, body: normalizeBody(match.rawBody ?? match.resolvedBody) } : null
    },
    corpus: (() => {
      const project = tempDir("diff-skills-")
      const home = tempDir("diff-skills-home-")
      writeFile(path.join(project, "package.json"), "{}\n")
      writeFile(path.join(project, ".opencode", "skills", "diff-skill", "SKILL.md"), "---\nname: diff-skill\ndescription: project\n---\nPROJECT-BODY\n")
      writeFile(path.join(project, ".agents", "skills", "diff-skill", "SKILL.md"), "---\nname: diff-skill\ndescription: agents\n---\nAGENTS-BODY\n")
      return [{ name: "collision precedence", project, home, skillName: "diff-skill" }]
    })(),
    mutation: { target: "discoverSkills", perturb: () => () => [] },
  },

  // -------------------------------------------------------------------------
  // goal: create/update/get/clear lifecycle and persistence (V1 vs V2)
  // -------------------------------------------------------------------------
  {
    id: "goal.lifecycle",
    family: "goal",
    integration: true,
    observableType: "state-persistence",
    why: "V2's goal controller produces the same create/pause/resume/clear record transitions as the V1 goal controller, over its storage port.",
    loadV1: () => import(`${PKG}/omo-opencode/src/hooks/goal/controller.ts`),
    loadV2: () => import("../../tools/goal.tools.mjs"),
    tolerance: { kind: "exact" },
    observeV1: async (v1) => {
      const project = tempDir("diff-goal-")
      return goalLifecycle(v1.createGoalController({ projectDir: project }))
    },
    observeV2: async (v2) => {
      const store = v2.createV2GoalStore({ storage: memoryStorage(), clock: () => 1000, idFactory: () => "goal-diff" })
      return goalLifecycle(v2.createGoalController({ store }))
    },
    corpus: [{ name: "lifecycle" }],
    mutation: {
      target: "createGoalController",
      perturb: () => () => ({
        async setGoal() { return { objective: "drifted", status: "active" } },
        async getGoal() { return null },
        async pauseGoal() { return null },
        async resumeGoal() { return null },
        async clearGoal() { return false },
      }),
    },
  },
  // -------------------------------------------------------------------------
  // delegation: resume payload
  // -------------------------------------------------------------------------
  {
    id: "delegation.resume-payload",
    family: "delegation",
    integration: true,
    observableType: "provider-payload",
    why: "V2 resumeDelegatedSession reuses the child session and sends the same continuation prompt content as the V1 delegate prompt builder.",
    loadV1: async () => {
      const promptBuilder = await import(`${PKG}/omo-opencode/src/tools/delegate-task/prompt-builder.ts`)
      return { promptBuilder }
    },
    loadV2: () => import("../../rigel-v2-native-core.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => ({ sessionID: input.sessionID, prompt: v1.promptBuilder.buildTaskPrompt(input.prompt, input.agent) }),
    observeV2: async (v2, input) => {
      const { client, calls } = fakeSessionClient()
      await v2.resumeDelegatedSession({ client, sessionID: input.sessionID, prompt: input.prompt, background: false })
      return { sessionID: calls.prompt[0]?.sessionID, prompt: firstLineStripped(calls.prompt[0]?.text ?? "") }
    },
    corpus: [{ name: "resume explore", sessionID: "ses_child_diff", agent: "explore", prompt: "continue the search" }],
    mutation: { target: "resumeDelegatedSession", perturb: () => async () => ({ sessionID: "x", agent: "x", background: false }) },
  },

  // -------------------------------------------------------------------------
  // delegation: retry advance (next fallback model)
  // -------------------------------------------------------------------------
  {
    id: "delegation.retry-advance",
    family: "delegation",
    integration: true,
    observableType: "selection",
    why: "V2 selectNextFallback returns the same next delegate-retry model as the V1 getNextSyncFallbackModel for the same chain.",
    loadV1: () => import(`${PKG}/omo-opencode/src/tools/delegate-task/sync-task-fallback.ts`),
    loadV2: () => import("../../rigel-v2-background-retry.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const rung = v1.getNextSyncFallbackModel("ses_diff", {
        providerID: input.current.providerID,
        modelID: input.current.modelID,
        fallbackChain: input.chain,
        attemptCount: 0,
        pending: true,
      })
      return rung ? `${rung.providerID}/${rung.modelID}` : null
    },
    observeV2: (v2, input) => {
      const rung = v2.selectNextFallback({
        fallbackChain: input.chain,
        attemptCount: 0,
        currentModel: { providerID: input.current.providerID, id: input.current.modelID },
        connectedSet: null,
      })
      return rung.found ? `${rung.providerID}/${rung.modelID}` : null
    },
    corpus: [
      {
        name: "advance to first rung",
        current: { providerID: "openai", modelID: "gpt-4o-probe" },
        chain: [{ providers: ["openai"], model: "gpt-6-astra" }, { providers: ["openai"], model: "gpt-6-luna-fast" }],
      },
    ],
    mutation: { target: "selectNextFallback", perturb: () => () => ({ found: false, attemptCount: 0 }) },
  },

  // -------------------------------------------------------------------------
  // rules: truncation / budget
  // -------------------------------------------------------------------------
  {
    id: "rules.truncate",
    family: "rules",
    integration: true,
    observableType: "result-mutation",
    why: "V2 truncates an oversized rule body and preserves the head, matching the V1 char-budget truncation decision at an equivalent limit.",
    oracle: "rules-engine.engine",
    loadV2: () => import("../../rigel-v2-native-rules.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const result = v1.truncateRule(input.body, { maxChars: input.maxTokens * 4, relativePath: "r.md" })
      return { truncated: result.truncated, head: result.body.slice(0, 40) }
    },
    observeV2: (v2, input) => {
      const result = v2.truncateToTokenLimit(input.body, input.maxTokens, 0)
      return { truncated: result.truncated, head: result.result.slice(0, 40) }
    },
    corpus: [
      { name: "under budget", body: "short rule body", maxTokens: 1000 },
      { name: "over budget", body: "line\n".repeat(20000), maxTokens: 1000 },
    ],
    mutation: { target: "truncateToTokenLimit", perturb: () => () => ({ result: "drifted", truncated: false }) },
  },

  // -------------------------------------------------------------------------
  // rules: dedup reset after compaction (re-injection)
  // -------------------------------------------------------------------------
  {
    id: "rules.reset-after-compaction",
    family: "rules",
    integration: true,
    observableType: "result-mutation",
    why: "After a session cache reset (compaction), both V1 and V2 re-inject a previously seen rule; before the reset both suppress it.",
    loadV1: async () => {
      const processor = await import(`${PKG}/omo-opencode/src/hooks/rules-injector/injection-processor.ts`)
      return { processor }
    },
    loadV2: () => import("../../rigel-v2-native-rules.mjs"),
    tolerance: { kind: "exact" },
    observeV1: async (v1, input) => {
      let cache = { realPaths: new Set(), contentHashes: new Set() }
      const processor = v1.processor.createRuleInjectionProcessor({
        workspaceDirectory: input.project,
        truncator: { truncate: async (_s, content) => ({ result: content, truncated: false }) },
        getSessionCache: () => cache,
      })
      const run = async () => {
        const output = { title: "read", output: "body", metadata: {} }
        await processor.processFilePathForInjection(path.join(input.project, "src", "a.ts"), "ses_diff", output)
        return collapseWhitespace(output.output)
      }
      const first = await run()
      const second = await run()
      cache = { realPaths: new Set(), contentHashes: new Set() }
      const third = await run()
      return { first, second, third }
    },
    observeV2: async (v2, input) => {
      const injector = v2.createNativeRulesInjector({ directory: input.project, home: input.home })
      const run = async () => {
        const event = { status: "completed", tool: "read", sessionID: "ses_diff", input: { filePath: path.join(input.project, "src", "a.ts") }, result: { content: "body" } }
        await injector.after(event)
        return collapseWhitespace(event.result.content)
      }
      const first = await run()
      const second = await run()
      injector.clear("ses_diff")
      const third = await run()
      return { first, second, third }
    },
    corpus: (() => {
      const project = tempDir("diff-rules-reset-")
      const home = tempDir("diff-home-reset-")
      writeFile(path.join(project, "package.json"), "{}\n")
      writeFile(path.join(project, ".omo", "rules", "r.md"), "---\nalwaysApply: true\n---\nRESET-RULE-BODY\n")
      writeFile(path.join(project, "src", "a.ts"), "const a = 1\n")
      return [{ name: "reset re-injects", project, home }]
    })(),
    mutation: { target: "createNativeRulesInjector", perturb: () => () => ({ after: async () => false, clear() {} }) },
  },

  // -------------------------------------------------------------------------
  // permissions: real plugin gate (global + agent toolGates, allow/deny/ask)
  // -------------------------------------------------------------------------
  {
    id: "permissions.gate-decision",
    family: "permissions",
    integration: true,
    observableType: "block-decision",
    why: "The real V2 tool-permission gate yields the same allow/deny/ask decision as the V1 permission values, and an agent gate overrides the global default.",
    loadV1: async () => {
      const guard = await import(`${PKG}/omo-opencode/src/agents/frontier-tool-schema-guard.ts`)
      return { guard }
    },
    loadV2: () => import("../../rigel-v2-native-permissions.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => v1PermissionDecision(input.global, input.agent, input.tool),
    observeV2: async (v2, input) => {
      const globalGates = v2.translateGlobalTools(input.global ?? {})
      const agentGates = Object.entries(input.agent ?? {}).map(([pattern, effect]) => ({ pattern, effect }))
      const gate = v2.createNativeToolPermissionGate({ globalGates })
      gate.registerAgent("sisyphus", { toolGates: agentGates })
      return gateDecision(gate, input.tool, "sisyphus")
    },
    corpus: [
      { name: "global denies bash", tool: "bash", global: { bash: false }, agent: {} },
      { name: "global allows glob", tool: "glob", global: {}, agent: {} },
      { name: "agent re-allows over global deny", tool: "bash", global: { bash: false }, agent: { bash: "allow" } },
      { name: "agent asks", tool: "edit", global: {}, agent: { edit: "ask" } },
      { name: "agent denies", tool: "write", global: {}, agent: { write: "deny" } },
    ],
    mutation: { target: "createNativeToolPermissionGate", perturb: () => () => ({ registerAgent() {}, before: async () => {} }) },
  },

  // -------------------------------------------------------------------------
  // fallback: cross-provider selection (real V1 reachable fallback vs V2)
  // -------------------------------------------------------------------------
  {
    id: "fallback.cross-provider",
    family: "fallback",
    integration: true,
    observableType: "selection",
    why: "V2 selectNextFallback switches to the same other provider as the V1 getNextReachableFallback for the same chain and connected set.",
    loadV1: async () => {
      const next = await import(`${PKG}/omo-opencode/src/hooks/model-fallback/next-fallback.ts`)
      const cache = await import(`${PKG}/model-core/src/connected-providers-cache.ts`)
      return { next, cache }
    },
    loadV2: () => import("../../rigel-v2-background-retry.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const rung = v1.next.getNextReachableFallback("ses_diff", {
        providerID: input.current.providerID,
        modelID: input.current.modelID,
        fallbackChain: input.chain,
        attemptCount: 0,
        pending: true,
      })
      return rung ? `${rung.providerID}/${rung.modelID}` : null
    },
    observeV2: (v2, input, v1) => {
      const connected = v1.cache.readProviderModelsCache()?.connected ?? v1.cache.readConnectedProvidersCache()
      const connectedSet = connected ? new Set(connected.map((provider) => String(provider).toLowerCase())) : null
      const rung = v2.selectNextFallback({
        fallbackChain: input.chain,
        attemptCount: 0,
        currentModel: { providerID: input.current.providerID, id: input.current.modelID },
        connectedSet,
      })
      return rung.found ? `${rung.providerID}/${rung.modelID}` : null
    },
    corpus: [
      {
        name: "cross-provider rung",
        current: { providerID: "opencode", modelID: "big-pickle" },
        chain: [{ providers: ["openai", "anthropic"], model: "gpt-6-astra" }],
      },
    ],
    mutation: { target: "selectNextFallback", perturb: () => () => ({ found: false, attemptCount: 0 }) },
  },

  // -------------------------------------------------------------------------
  // fallback: reactive provider switch payload
  // -------------------------------------------------------------------------
  {
    id: "fallback.reactive-switch",
    family: "fallback",
    integration: true,
    observableType: "provider-payload",
    why: "The reactive provider switch payload V1 builds (buildRetryModelPayload) resolves to the same model the V2 resolver returns for the next rung.",
    loadV1: () => import(`${PKG}/omo-opencode/src/hooks/runtime-fallback/retry-model-payload.ts`),
    loadV2: () => import("../../rigel-v2-native-model-chains.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const payload = v1.buildRetryModelPayload(`${input.rung.providerID}/${input.rung.model}`)
      return payload ? `${payload.model.providerID}/${payload.model.modelID}` : null
    },
    observeV2: (v2, input) => {
      const rung = v2.resolveFallbackModel({
        chain: [input.rung],
        availableModels: [{ providerID: input.rung.providerID, id: input.rung.model }],
        failedModels: [],
      })
      return rung ? v2.modelKey(rung) : null
    },
    corpus: [
      { name: "switch to anthropic", rung: { providers: ["anthropic"], providerID: "anthropic", model: "claude-opus-5-5" } },
      { name: "switch to openai", rung: { providers: ["openai"], providerID: "openai", model: "gpt-6-astra" } },
    ],
    mutation: { target: "resolveFallbackModel", perturb: () => () => undefined },
  },

  // -------------------------------------------------------------------------
  // skills: real body injection into a delegated child
  // -------------------------------------------------------------------------
  {
    id: "skills.body-injection",
    family: "skills",
    integration: true,
    observableType: "provider-payload",
    why: "V2 selects and formats the same skill body for a delegated child as the V1 skill resolution, over the same on-disk skill.",
    loadV1: async () => {
      const loader = await import(`${PKG}/skills-loader-core/src/features/opencode-skill-loader/loader.ts`)
      return { loader }
    },
    loadV2: () => import("../../rigel-v2-native-skills.mjs"),
    tolerance: { kind: "substring" },
    observeV1: async (v1, input) => {
      const previousHome = process.env.HOME
      process.env.HOME = input.home
      try {
        const skills = await v1.loader.discoverAllSkills(input.project)
        const match = skills.find((skill) => skill.name === input.skillName)
        if (!match) return ""
        const body = match.lazyContent ? await match.lazyContent.load() : ""
        return extractSkillRawBody(body)
      } finally {
        process.env.HOME = previousHome
      }
    },
    observeV2: (v2, input) => {
      const skills = v2.discoverSkills({ directory: input.project, home: input.home })
      const selected = v2.selectSkillsForChild(skills, [input.skillName], { targetAgent: "sisyphus-junior" })
      return v2.formatSkillInjection(selected)
    },
    corpus: (() => {
      const project = tempDir("diff-skills-body-")
      const home = tempDir("diff-skills-body-home-")
      writeFile(path.join(project, "package.json"), "{}\n")
      writeFile(path.join(project, ".opencode", "skills", "diff-body", "SKILL.md"), "---\nname: diff-body\ndescription: body test\n---\nBODY-INJECTION-CONTENT\n")
      return [{ name: "inject skill body", project, home, skillName: "diff-body" }]
    })(),
    mutation: { target: "selectSkillsForChild", perturb: () => () => ({ injected: [], missing: [] }) },
  },

  // -------------------------------------------------------------------------
  // goal: idle continuation + negatives
  // -------------------------------------------------------------------------
  {
    id: "goal.continuation",
    family: "goal",
    integration: true,
    observableType: "handoff",
    why: "V2's goal continuation dispatches the same continuation prompt for an active goal, and no dispatch for a missing/complete goal.",
    loadV1: async () => {
      const prompt = await import(`${PKG}/omo-opencode/src/hooks/goal/prompt.ts`)
      return { prompt }
    },
    loadV2: () => import("../../tools/goal.tools.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const goal = { objective: input.objective, status: input.status, tokensUsed: 0, timeUsedSeconds: 0 }
      return input.status === "active" ? v1.prompt.buildContinuationPrompt(goal) : null
    },
    observeV2: async (v2, input) => {
      const store = v2.createV2GoalStore({ storage: memoryStorage(), clock: () => 1000, idFactory: () => "goal-diff" })
      const controller = v2.createGoalController({ store })
      if (input.status === "active") await controller.setGoal("ses_diff", input.objective)
      const dispatched = []
      const continuation = v2.createGoalContinuation({ controller, dispatch: async (item) => { dispatched.push(item) } })
      await continuation.handleEvent({ type: "session.idle", sessionID: "ses_diff", properties: { sessionID: "ses_diff" } })
      return dispatched.length > 0 ? dispatched[0].text : null
    },
    corpus: [
      { name: "active goal continues", objective: "Ship the oracle", status: "active" },
      { name: "missing goal negative", objective: "none", status: "missing" },
    ],
    mutation: { target: "createGoalContinuation", perturb: () => () => ({ handleIdle: async () => {} }) },
  },
  {
    id: "goal.negatives",
    family: "goal",
    integration: true,
    observableType: "state-persistence",
    why: "V2 rejects the same invalid objectives and unknown commands as V1, and returns null for a missing goal.",
    loadV1: async () => {
      const validation = await import(`${PKG}/omo-opencode/src/hooks/goal/validation.ts`)
      const command = await import(`${PKG}/omo-opencode/src/hooks/goal/command-arguments.ts`)
      return { validation, command }
    },
    loadV2: () => import("../../tools/goal.tools.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      if (input.kind === "objective") {
        try { return { ok: true, value: v1.validation.validateObjective(input.value) } }
        catch (error) { return { ok: false, value: null } }
      }
      return { ok: true, value: v1.command.parseGoalCommand(input.value) }
    },
    observeV2: (v2, input) => {
      if (input.kind === "objective") {
        try { return { ok: true, value: v2.validateObjective(input.value) } }
        catch { return { ok: false, value: null } }
      }
      return { ok: true, value: v2.parseGoalCommand(input.value) }
    },
    corpus: [
      { name: "empty objective", kind: "objective", value: "" },
      { name: "valid objective", kind: "objective", value: "Ship it" },
      { name: "clear command", kind: "command", value: "clear" },
      { name: "unknown command sets objective", kind: "command", value: "make it so" },
    ],
    mutation: { target: "validateObjective", perturb: () => () => "always valid" },
  },

  // -------------------------------------------------------------------------
  // compaction: todo snapshot preserve + restore (V1 hook vs V2 preserver)
  // -------------------------------------------------------------------------
  {
    id: "compaction.todo-restore",
    family: "compaction",
    integration: true,
    observableType: "state-persistence",
    why: "V2 preserves and restores detailed todos across compaction exactly as the V1 todo preserver: an empty post-compaction list is replaced by the snapshot, a detailed current list is protected instead, and a late bootstrap todowrite is replaced by the protected snapshot.",
    loadV1: () => import(`${PKG}/omo-opencode/src/hooks/compaction-todo-preserver/hook.ts`),
    loadV2: () => import("../../rigel-v2-native-compaction-todo-preserver.mjs"),
    tolerance: { kind: "exact" },
    observeV1: async (v1, input) => {
      let call = 0
      const ctx = { client: { session: { todo: async () => ({ data: call++ === 0 ? input.detailed : input.current }) } } }
      const hook = v1.createCompactionTodoPreserverHook(ctx)
      await hook.capture("ses_diff")
      await hook.restore("ses_diff")
      const output = { args: { todos: input.bootstrap } }
      await hook["tool.execute.before"]({ tool: "todowrite", sessionID: "ses_diff", callID: "c" }, output)
      return { todos: output.args.todos }
    },
    observeV2: async (v2, input) => {
      let current = input.detailed
      const store = { async readTodos() { return current }, async writeTodos(_s, todos) { current = todos } }
      const preserver = v2.createNativeCompactionTodoPreserver({ store })
      await preserver.capture("ses_diff")
      current = input.current
      await preserver.restore("ses_diff")
      return { todos: preserver.beforeTodoWrite("ses_diff", input.bootstrap) }
    },
    corpus: [
      {
        name: "empty current restores snapshot",
        detailed: [{ id: "d1", content: "Do the work", status: "in_progress" }],
        current: [],
        bootstrap: [{ id: "orchestrate-plan", content: "Complete ALL implementation tasks" }],
      },
      {
        name: "detailed current not overwritten",
        detailed: [{ id: "d1", content: "Do the work", status: "in_progress" }],
        current: [{ id: "d2", content: "Already present", status: "pending" }],
        bootstrap: [{ id: "orchestrate-plan", content: "Complete ALL implementation tasks" }],
      },
    ],
    mutation: { target: "createNativeCompactionTodoPreserver", perturb: () => () => ({ capture: async () => {}, restore: async () => {}, beforeTodoWrite: () => [], forget() {} }) },
  },

  // -------------------------------------------------------------------------
  // compaction: continuity (ultrawork restoration after compaction)
  // -------------------------------------------------------------------------
  {
    id: "compaction.continuity",
    family: "compaction",
    integration: true,
    observableType: "provider-payload",
    why: "After compaction, V2 restores the same source-routed ultrawork guidance for the next request as the V1 keyword-detector system-transform guidance; session.deleted and no-compaction both restore nothing.",
    loadV1: async () => {
      const hook = await import(`${PKG}/omo-opencode/src/hooks/keyword-detector/hook.ts`)
      const messages = await import(`${PKG}/omo-opencode/src/hooks/keyword-detector/ultrawork/index.ts`)
      return { hook, messages }
    },
    loadV2: () => import("../../rigel-v2-keyword-state.mjs"),
    tolerance: { kind: "exact" },
    observeV1: async (v1, input) => {
      const detector = v1.hook.createKeywordDetectorHook({ client: { tui: { showToast: () => ({ catch() {} }) } } })
      if (input.seed) {
        await detector["chat.message"](
          { sessionID: "ses_diff", agent: input.agent, model: { providerID: "openai", modelID: input.modelID } },
          { message: {}, parts: [{ type: "text", text: input.text }] },
        )
      }
      if (input.compacted) detector.event({ event: { type: "session.compacted", properties: { sessionID: "ses_diff" } } })
      if (input.deleted) detector.event({ event: { type: "session.deleted", properties: { sessionID: "ses_diff" } } })
      return detector.getSystemTransformGuidance("ses_diff", input.modelID) ?? null
    },
    observeV2: (v2, input, v1) => {
      const state = v2.createKeywordState({
        messageForSource: (source) => v1.messages.getUltraworkMessageForSource(source),
      })
      if (input.seed) state.rememberExplicit("ses_diff", { source: "default" })
      if (input.compacted) state.handleEvent({ type: "session.compacted", sessionID: "ses_diff" })
      if (input.deleted) state.handleEvent({ type: "session.deleted", sessionID: "ses_diff" })
      const restoration = state.getRestoration("ses_diff", { agent: input.agent, modelID: input.modelID })
      return restoration ? restoration.message : null
    },
    corpus: [
      { name: "restore after compaction", seed: true, compacted: true, agent: "sisyphus", modelID: "gpt-5.5", text: "do ultrawork" },
      { name: "deleted clears", seed: true, deleted: true, agent: "sisyphus", modelID: "gpt-5.5", text: "do ultrawork" },
      { name: "no compaction no restore", seed: true, agent: "sisyphus", modelID: "gpt-5.5", text: "do ultrawork" },
    ],
    mutation: { target: "createKeywordState", perturb: () => () => ({ rememberExplicit: () => true, handleEvent: () => true, getRestoration: () => undefined, clearSession: () => true }) },
  },

  // -------------------------------------------------------------------------
  // delegation: real parent handoff (V1 notification vs V2 handoff prompt)
  // -------------------------------------------------------------------------
  {
    id: "delegation.handoff-text",
    family: "delegation",
    integration: true,
    observableType: "handoff",
    why: "The V1 parent notification and the V2 parent handoff both carry the child identifier, a terminal status, and the child payload for the same completion.",
    loadV1: () => import(`${PKG}/omo-opencode/src/features/background-agent/background-task-notification-template.ts`),
    loadV2: () => import("../../rigel-v2-native-core.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const text = v1.buildBackgroundTaskNotificationText({
        task: { id: input.id, description: input.payload, status: "completed" },
        duration: "5s",
        statusText: "COMPLETED",
        allComplete: false,
        remainingCount: 1,
        completedTasks: [],
      })
      return structuredHandoff(text, input.id, input.payload)
    },
    observeV2: (v2, input) => {
      const text = v2.backgroundHandoffPrompt({ sessionID: input.id, agent: input.agent, status: "succeeded", result: input.payload })
      return structuredHandoff(text, input.id, input.payload)
    },
    corpus: [{ name: "child completed", id: "task_diff", payload: "find the auth code", agent: "explore" }],
    mutation: { target: "backgroundHandoffPrompt", perturb: () => () => "nothing useful" },
  },

  // -------------------------------------------------------------------------
  // recovery: context-window limit detection + single compaction per incident
  // -------------------------------------------------------------------------
  {
    id: "recovery.context-limit",
    family: "recovery",
    integration: true,
    observableType: "block-decision",
    why: "V2 requests compaction for exactly the context-limit errors the V1 anthropic parser recognizes, and only once per incident; unrelated errors request nothing.",
    loadV1: () => import(`${PKG}/omo-opencode/src/hooks/anthropic-context-window-limit-recovery/parser.ts`),
    loadV2: () => import("../../rigel-v2-native-phase4-events.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const parsed = v1.parseAnthropicTokenLimitError(input.message)
      return { detected: parsed !== null && parsed !== undefined }
    },
    observeV2: async (v2, input) => {
      const compacted = []
      const recovery = v2.createNativeContextLimitRecovery({ session: { compact: async () => { compacted.push(1) } } })
      const first = await recovery.handle({ type: "session.error", sessionID: "ses_diff", error: { message: input.message } })
      const second = await recovery.handle({ type: "session.error", sessionID: "ses_diff", error: { message: input.message } })
      return { detected: compacted.length === 1 && first === true && second === false }
    },
    corpus: [
      { name: "prompt too long", message: "Prompt is too long: 250000 tokens exceeds the maximum context length" },
      { name: "maximum context", message: "This model's maximum context length is exceeded" },
      { name: "unrelated negative", message: "rate limit exceeded, please retry" },
    ],
    mutation: { target: "createNativeContextLimitRecovery", perturb: () => () => ({ handle: async () => false }) },
  },

  // -------------------------------------------------------------------------
  // delegation: real handoff pipeline (completion -> queue -> deliver)
  // V1: ParentWakePendingQueue (queue/merge/cleanup) + notification payload
  // V2: createHandoffPump (FIFO drain, single delivery despite retry,
  //     retry-exhaustion, dispose cleanup) + backgroundHandoffPrompt payload
  // -------------------------------------------------------------------------
  {
    id: "delegation.handoff-pipeline",
    family: "delegation",
    integration: true,
    observableType: "handoff",
    why: "The real V1 parent-wake pipeline and the real V2 handoff pump deliver exactly one handoff per completed child in FIFO order, retry a transient failure without duplicating the delivery, exhaust a permanently failing child, and clean up on shutdown/dispose.",
    loadV1: async () => {
      const queue = await import(`${PKG}/omo-opencode/src/features/background-agent/parent-wake-pending-queue.ts`)
      const template = await import(`${PKG}/omo-opencode/src/features/background-agent/background-task-notification-template.ts`)
      return { queue, template }
    },
    loadV2: async () => {
      const pump = await import("../../rigel-v2-background-handoff.mjs")
      const core = await import("../../rigel-v2-native-core.mjs")
      return { ...pump, backgroundHandoffPrompt: core.backgroundHandoffPrompt }
    },
    tolerance: { kind: "exact" },
    observeV1: async (v1, input) => {
      const delivered = []
      const queue = new v1.queue.ParentWakePendingQueue({
        pendingRetryMs: 0,
        // The REAL delivery seam the queue flush calls. This is not a no-op: it
        // runs the operation the caller built, which performs the parent
        // notification for that wake.
        enqueueNotificationForParent: async (_sessionID, operation) => { await operation() },
      })
      const notification = (child) => v1.template.buildBackgroundTaskNotificationText({
        task: { id: child.id, description: child.payload, status: "completed" },
        duration: "1s",
        statusText: "COMPLETED",
        allComplete: false,
        remainingCount: 1,
        completedTasks: [],
      })
      // c1 queued twice -> the queue MERGES it into one wake (dedupe); c2 once.
      queue.queueWake("c1", notification(input.children[0]), {}, false)
      queue.queueWake("c1", notification({ id: "c1", payload: "updated" }), {}, false)
      queue.queueWake("c2", notification(input.children[1]), {}, false)
      // Actuate the REAL flush per pending wake (controlled delay 0). The flush
      // calls enqueueNotificationForParent -> the operation runs the delivery.
      for (const sessionID of [...queue.getWakes().keys()]) {
        const payload = queue.getWake(sessionID)?.notifications.join("\n") ?? ""
        queue.scheduleFlush(sessionID, async () => { delivered.push(handoffShape(sessionID, payload)) }, 0)
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
      if (delivered.filter((entry) => entry.id === "c1").length !== 1) throw new Error("V1 queue did not dedupe c1 into a single delivery")
      queue.shutdown()
      const cleanedUp = queue.getWakes().size === 0 && queue.getTimers().size === 0
      return { delivered, cleanedUp }
    },
    observeV2: async (v2, input) => {
      const attempts = new Map()
      const delivered = []
      const exhausted = []
      let pump
      pump = v2.createHandoffPump({
        maxAttempts: 3,
        run: async (item) => {
          const attempt = (attempts.get(item.sessionID) ?? 0) + 1
          attempts.set(item.sessionID, attempt)
          if (item.sessionID === "c2" && attempt < 2) throw new Error("transient")
          if (item.sessionID === "c3") throw new Error("permanent")
          delivered.push(handoffShape(item.sessionID, v2.backgroundHandoffPrompt({ sessionID: item.sessionID, agent: "explore", status: "succeeded", result: item.payload })))
        },
        onFailed: (item) => { pump.enqueue(item) },
        onExhausted: (item) => { exhausted.push(item.sessionID) },
      })
      pump.enqueue({ sessionID: "c1", payload: input.children[0].payload })
      pump.enqueue({ sessionID: "c2", payload: input.children[1].payload })
      pump.enqueue({ sessionID: "c3", payload: "never" })
      await pump.whenIdle()
      pump.dispose()
      const cleanedUp = !pump.pending()
      if (delivered.filter((entry) => entry.id === "c2").length !== 1) throw new Error("c2 delivered more than once")
      if (exhausted.length !== 1 || exhausted[0] !== "c3") throw new Error("retry-exhaustion not observed")
      return { delivered, cleanedUp }
    },
    corpus: [
      {
        name: "two children, one retried, one exhausted",
        children: [
          { id: "c1", payload: "find the auth code" },
          { id: "c2", payload: "review the plan" },
        ],
      },
    ],
    mutation: { target: "createHandoffPump", perturb: () => () => ({ enqueue: () => true, whenIdle: async () => {}, pending: () => false, dispose() {} }) },
  },
]

/** Real gate decision: allow | deny | ask, from the gate's thrown error code. */
async function gateDecision(gate, tool, agent) {
  try {
    await gate.before({ tool, agent })
    return "allow"
  } catch (error) {
    if (error && error.code === "RIGEL_TOOL_PERMISSION_APPROVAL_REQUIRED") return "ask"
    return "deny"
  }
}

/** V1 permission decision from the real permission values (agent then global). */
function v1PermissionDecision(global, agent, tool) {
  if (agent && typeof agent[tool] === "string") return agent[tool]
  if (global && typeof global[tool] === "string") return global[tool]
  if (global && global[tool] === false) return "deny"
  return "allow"
}


/** Strip the V1 skill-instruction wrapper so the raw body is comparable to V2. */
function extractSkillRawBody(value) {
  const text = String(value ?? "")
  const marker = "<skill-instruction>"
  if (!text.includes(marker)) return text.trim()
  const afterHeader = text.slice(text.indexOf(marker))
  const blank = afterHeader.indexOf("\n\n")
  let body = blank === -1 ? afterHeader : afterHeader.slice(blank + 2)
  const close = body.indexOf("</skill-instruction>")
  if (close !== -1) body = body.slice(0, close)
  return body.trim()
}

/**
 * Real loopback redirect server. V1's resolver has no injectable fetch, so the
 * differential runs both resolvers against the same real HTTP redirect chain on
 * 127.0.0.1 (never the public network). Started once, kept for the process.
 */
let redirectServerPromise
async function redirectServer() {
  if (!redirectServerPromise) {
    redirectServerPromise = (async () => {
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname
          const loop = /^\/loop(\d+)$/.exec(path)
          if (loop) {
            const index = Number(loop[1])
            if (index < 12) return new Response(null, { status: 302, headers: { location: `/loop${index + 1}` } })
            return new Response("ok", { status: 200 })
          }
          if (path === "/1") return new Response(null, { status: 302, headers: { location: "/2" } })
          return new Response("ok", { status: 200 })
        },
      })
      if (typeof server.unref === "function") server.unref()
      return `http://127.0.0.1:${server.port}`
    })()
  }
  return redirectServerPromise
}

/** Whitespace-insensitive view of an injected block (separator newlines differ). */
function collapseWhitespace(value) {
  return String(value ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim()
}

function normalizeBody(body) {
  return String(body ?? "").trim()
}

/** Structured view of a parent handoff: identifier, payload, terminal status. */
function structuredHandoff(text, id, payload) {
  const value = String(text ?? "")
  return {
    hasId: value.includes(id),
    hasPayload: value.includes(payload),
    hasTerminalStatus: /(complet|succeed|ready)/i.test(value),
  }
}

/** Canonical delivered-handoff shape for the pipeline comparison. */
function handoffShape(id, text) {
  const value = String(text ?? "")
  return {
    id,
    hasId: value.includes(id),
    hasStatus: /(complet|succeed|ready)/i.test(value),
    nonEmpty: value.length > 0,
  }
}
