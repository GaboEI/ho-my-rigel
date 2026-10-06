import { expect, test } from "bun:test"
import {
  BUILTIN_COMMAND_NAMES,
  createBuiltinCommandDefinitions,
  registerBuiltinCommands,
  renderBuiltinCommandTemplate,
} from "./rigel-v2-native-builtin-commands.mjs"

function captureContext() {
  const prompts = []
  const added = []
  const context = {
    session: { prompt: async (input) => { prompts.push(input); return { data: {} } } },
    command: {
      transform: async (callback) => {
        callback({ add: (definition) => added.push(definition) })
        return { dispose() {} }
      },
    },
  }
  return { context, prompts, added }
}

function fixtureManifest() {
  return {
    commands: {
      demo: {
        description: "Demo command",
        template: "base $ARGUMENTS at $SESSION_ID on $TIMESTAMP",
        teamModeTemplate: "team $ARGUMENTS at $SESSION_ID on $TIMESTAMP",
      },
      other: { description: "Other", template: "other $ARGUMENTS", teamModeTemplate: "other $ARGUMENTS" },
    },
  }
}

test("#given a template with every placeholder #when rendering #then arguments, session and timestamp resolve without touching other dollars", () => {
  const rendered = renderBuiltinCommandTemplate("a $ARGUMENTS b ${ARGUMENTS} c $1 d $SESSION_ID e $TIMESTAMP f $omo:remove-ai-slops g $BASE_BRANCH h $(git status)", {
    args: "TARGET",
    sessionID: "ses_1",
    timestamp: "2026-10-06T00:00:00.000Z",
  })
  expect(rendered).toBe("a TARGET b TARGET c TARGET d ses_1 e 2026-10-06T00:00:00.000Z f $omo:remove-ai-slops g $BASE_BRANCH h $(git status)")
})

test("#given the real manifest #when building definitions #then one executable definition exists per migrated command", () => {
  const { context } = captureContext()
  const definitions = createBuiltinCommandDefinitions({ context })
  expect(definitions.map((definition) => definition.name)).toEqual([...BUILTIN_COMMAND_NAMES])
  for (const definition of definitions) {
    expect(typeof definition.execute).toBe("function")
    expect(definition.description.length).toBeGreaterThan(0)
  }
})

test("#given a disabled command #when building definitions #then it is omitted", () => {
  const { context } = captureContext()
  const definitions = createBuiltinCommandDefinitions({ context, manifest: fixtureManifest(), disabledCommands: ["other"] })
  expect(definitions.map((definition) => definition.name)).toEqual(["demo"])
})

test("#given team mode on #when executing #then the team-mode template is delivered", async () => {
  const { context, prompts } = captureContext()
  const [definition] = createBuiltinCommandDefinitions({ context, manifest: fixtureManifest(), teamModeEnabled: true, now: () => new Date("2026-10-06T00:00:00.000Z") })
  await definition.execute({ sessionID: "ses_1", prompt: { text: "X" }, delivery: "queue" })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toEqual({ text: "team X at ses_1 on 2026-10-06T00:00:00.000Z", sessionID: "ses_1", delivery: "queue" })
})

test("#given team mode off #when executing #then the base template is delivered and prompt fields are preserved", async () => {
  const { context, prompts } = captureContext()
  const [definition] = createBuiltinCommandDefinitions({ context, manifest: fixtureManifest(), now: () => new Date("2026-10-06T00:00:00.000Z") })
  await definition.execute({ sessionID: "ses_2", prompt: { name: "demo", text: "X", files: ["f"] }, delivery: "steer" })
  expect(prompts[0]).toEqual({ name: "demo", files: ["f"], text: "base X at ses_2 on 2026-10-06T00:00:00.000Z", sessionID: "ses_2", delivery: "steer" })
})

test("#given an empty session #when executing #then nothing is delivered", async () => {
  const { context, prompts } = captureContext()
  const [definition] = createBuiltinCommandDefinitions({ context, manifest: fixtureManifest() })
  await definition.execute({ sessionID: "", prompt: { text: "X" } })
  await definition.execute({ prompt: { text: "X" } })
  expect(prompts).toHaveLength(0)
})

test("#given a host command domain #when registering #then every definition reaches the editor", async () => {
  const { context, added } = captureContext()
  const registration = await registerBuiltinCommands({ context })
  expect(typeof registration?.dispose).toBe("function")
  expect(added.map((definition) => definition.name)).toEqual([...BUILTIN_COMMAND_NAMES])
})

test("#given no command domain #when registering #then registration is a no-op", async () => {
  const registration = await registerBuiltinCommands({ context: { session: { prompt: async () => ({ data: {} }) } } })
  expect(registration).toBeUndefined()
})

test("#given a fully disabled set #when registering #then registration is a no-op", async () => {
  const { context, added } = captureContext()
  const registration = await registerBuiltinCommands({ context, disabledCommands: [...BUILTIN_COMMAND_NAMES] })
  expect(registration).toBeUndefined()
  expect(added).toHaveLength(0)
})
