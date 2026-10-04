import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import http from "node:http"
import {
  createNativeWebFetchRedirectGuard,
  MAX_WEBFETCH_REDIRECTS,
} from "./rigel-v2-native-webfetch-redirect-guard.mjs"

let base
const server = http.createServer((req, res) => {
  const url = req.url
  if (url === "/a") {
    res.writeHead(302, { Location: "/final" })
    res.end()
    return
  }
  if (url === "/final") {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("final body")
    return
  }
  if (url === "/ok") {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("ok body")
    return
  }
  const hop = /^\/r(\d+)$/.exec(url)
  if (hop) {
    const step = Number(hop[1])
    if (step >= 11) {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("end of chain")
      return
    }
    res.writeHead(302, { Location: `/r${step + 1}` })
    res.end()
    return
  }
  res.writeHead(404)
  res.end()
})

beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

describe("Rigel native V2 webfetch redirect guard", () => {
  describe("#given a URL that redirects once to a final 200", () => {
    describe("#when before runs", () => {
      test("#then rewrites the args url to the final url", async () => {
        const guard = createNativeWebFetchRedirectGuard()
        const event = {
          tool: "webfetch",
          sessionID: "ses_happy",
          id: "call_happy",
          input: { url: `${base}/a`, format: "markdown" },
        }

        await guard.before(event)

        expect(event.input.url).toBe(`${base}/final`)
      })
    })
  })

  describe("#given a chain of 11 redirects that exceeds the limit", () => {
    describe("#when before then after run", () => {
      test("#then tracks the failure and rewrites the mutable result text", async () => {
        const guard = createNativeWebFetchRedirectGuard()
        const url = `${base}/r0`
        const before = { tool: "webfetch", sessionID: "ses_block", id: "call_block", input: { url } }

        await guard.before(before)
        expect(before.input.url).toBe(url)

        const after = {
          tool: "webfetch",
          sessionID: "ses_block",
          id: "call_block",
          output: "Error: the response redirected too many times",
        }
        await guard.after(after)

        expect(after.output).toContain(`exceeded maximum redirects (${MAX_WEBFETCH_REDIRECTS})`)
        expect(after.output).toContain(url)
      })
    })
  })

  describe("#given a direct 200 URL", () => {
    describe("#when before runs", () => {
      test("#then leaves the args url unchanged", async () => {
        const guard = createNativeWebFetchRedirectGuard()
        const event = { tool: "webfetch", sessionID: "ses_ok", id: "call_ok", input: { url: `${base}/ok` } }

        await guard.before(event)

        expect(event.input.url).toBe(`${base}/ok`)
      })
    })
  })

  describe("#given a result carried as text content parts", () => {
    describe("#when a raw redirect-loop error has no tracked state", () => {
      test("#then normalizes the part text without a url", async () => {
        const guard = createNativeWebFetchRedirectGuard()
        const part = { type: "text", text: "error: too many redirects" }
        const after = { tool: "webfetch", sessionID: "ses_parts", id: "call_parts", output: { content: [part] } }

        await guard.after(after)

        expect(part.text).toBe(`Error: WebFetch failed: exceeded maximum redirects (${MAX_WEBFETCH_REDIRECTS})`)
      })
    })
  })

  describe("#given successful content that merely mentions redirect loops", () => {
    describe("#when after runs", () => {
      test("#then keeps the text unchanged", async () => {
        const guard = createNativeWebFetchRedirectGuard()
        const after = {
          tool: "webfetch",
          sessionID: "ses_content",
          id: "call_content",
          output: "This page explains why browsers hit too many redirects in some setups.",
        }

        await guard.after(after)

        expect(after.output).toBe("This page explains why browsers hit too many redirects in some setups.")
      })
    })
  })
})
