// Minimal, same-origin deep-link helper for the catalogue. Native <details> handles
// expand/collapse, keyboard and focus; this script only opens the targeted fiche so a
// deep link from the cover or an external page lands on an OPEN summary. No third party,
// no inline handler, no navigation.
function openHash() {
  const id = decodeURIComponent(window.location.hash.slice(1))
  if (!id) return
  const el = document.getElementById(id)
  if (el && el.tagName === "DETAILS") el.open = true
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text)
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  ta.style.position = "absolute"
  ta.style.insetInlineStart = "-9999px"
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand("copy")
  ta.remove()
  return ok ? Promise.resolve() : Promise.reject(new Error("execCommand copy failed"))
}

// One integrated icon control per command row. Success swaps the icon to a check; failure
// swaps it to an X and marks the whole row (`is-error`) so the row border and the visible
// status text carry the failure beside the icon (never colour alone). Both states announce
// through the row's live region and clear themselves after their own window; a new attempt
// cancels the pending reset of the previous one.
const copyResets = new WeakMap()

function startCopy(button) {
  const text = button.getAttribute("data-copy") || ""
  const done = button.getAttribute("data-copied") || "Copied"
  const fail = button.getAttribute("data-error") || "Copy failed"
  const row = button.closest(".cmd")
  const status = row ? row.querySelector(".cmd__status") : null
  const clear = () => {
    copyResets.delete(button)
    button.classList.remove("is-done", "is-error")
    if (row) row.classList.remove("is-done", "is-error")
    if (status) status.textContent = ""
  }
  const settle = (state, message, ms) => {
    const pending = copyResets.get(button)
    if (pending) window.clearTimeout(pending)
    button.classList.remove("is-done", "is-error")
    if (row) row.classList.remove("is-done", "is-error")
    button.classList.add(state)
    if (row) row.classList.add(state)
    if (status) status.textContent = message
    copyResets.set(button, window.setTimeout(clear, ms))
  }
  copyText(text).then(
    () => settle("is-done", done, 2000),
    () => settle("is-error", fail, 3000),
  )
}

function wireCopy() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".copy")
    if (!button) return
    startCopy(button)
  })
}

// Toggle controls the SAME nav (no duplicate navigation) via aria-expanded/aria-controls; CSS keeps the nav always visible on wide screens.
function wireNav() {
  const toggle = document.querySelector(".nav-toggle")
  const nav = document.getElementById("site-nav")
  if (!toggle || !nav) return
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open")
    toggle.setAttribute("aria-expanded", String(open))
  })
}

window.addEventListener("DOMContentLoaded", () => { openHash(); wireCopy(); wireNav() })
window.addEventListener("hashchange", openHash)
