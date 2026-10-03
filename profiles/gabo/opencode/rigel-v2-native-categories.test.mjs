import { test, expect } from "bun:test"
import { availableCategoryNames, resolveCategory } from "./rigel-v2-native-categories.mjs"

test("exports the complete upstream builtin category set", () => {
  expect(availableCategoryNames()).toEqual([
    "artistry", "deep-high", "deep-low", "quick", "ultrabrain",
    "unspecified-high", "unspecified-low", "visual-engineering", "writing",
  ])
})

test("resolves a category against the location-scoped V2 model inventory", async () => {
  const calls = []
  const result = await resolveCategory({
    model: { list: async (input) => {
      calls.push(input)
      return { data: [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }] }
    } },
  }, { directory: "/project" }, "quick")
  expect(calls).toEqual([{ location: { directory: "/project" } }])
  expect(result.model).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
})

test("falls to the next reachable rung when the primary category model is absent", async () => {
  const result = await resolveCategory({
    model: { list: async () => ({ data: [{ providerID: "deepseek", id: "deepseek-flash", enabled: true }] }) },
  }, { directory: "/project" }, "quick")
  expect(result.model).toEqual({ providerID: "deepseek", id: "deepseek-flash", variant: "off" })
})

test("never silently substitutes an unavailable category model", async () => {
  await expect(resolveCategory({
    model: { list: async () => ({ data: [{ providerID: "other", id: "model" }] }) },
  }, { directory: "/project" }, "quick")).rejects.toThrow('Category "quick" requires one of its canonical fallback models')
})

test("never cross-routes a category rung to an undeclared provider", async () => {
  await expect(resolveCategory({
    model: { list: async () => ({ data: [{ providerID: "some-other", id: "gpt-6-luna-fast", enabled: true }] }) },
  }, { directory: "/project" }, "quick")).rejects.toThrow('Category "quick" requires one of its canonical fallback models')
})
