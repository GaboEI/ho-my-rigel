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

// The toggle opens the SAME nav (no duplicate navigation) via aria-expanded/aria-controls; CSS
// keeps the nav inline on wide screens and shows it as an absolute overlay on narrow ones, so it
// never pushes the main content. It closes on a link pick, Escape, or an outside click.
function wireNav() {
  const toggle = document.querySelector(".nav-toggle")
  const nav = document.getElementById("site-nav")
  if (!toggle || !nav) return
  const isOpen = () => nav.classList.contains("is-open")
  const setOpen = (open) => {
    nav.classList.toggle("is-open", open)
    toggle.setAttribute("aria-expanded", String(open))
  }
  toggle.addEventListener("click", () => setOpen(!isOpen()))
  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(false)
  })
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      setOpen(false)
      toggle.focus()
    }
  })
  document.addEventListener("click", (event) => {
    if (isOpen() && !nav.contains(event.target) && !toggle.contains(event.target)) setOpen(false)
  })
}

// Theme picker: a compact button (current-mode icon + caret) that opens a menu with Sistema,
// Claro and Oscuro. The pre-paint inline snippet already applied the saved choice; here we mark
// the active option, apply and persist a pick, and close the menu on pick, Escape or outside
// click. Persistence is best-effort: a denied or full localStorage must never throw.
function readStoredTheme() {
  try {
    var value = window.localStorage ? window.localStorage.getItem("omr-theme") : null
    return value === "light" || value === "dark" ? value : "system"
  } catch (e) {
    return "system"
  }
}

function applyTheme(value) {
  var root = document.documentElement
  if (!root) return
  if (value === "light" || value === "dark") root.setAttribute("data-theme", value)
  else root.removeAttribute("data-theme")
}

function storeTheme(value) {
  try {
    if (window.localStorage) window.localStorage.setItem("omr-theme", value)
  } catch (e) {}
}

function wireTheme() {
  var root = document.querySelector("[data-theme-switch]")
  if (!root) return
  var button = root.querySelector("[data-theme-menu-button]")
  var options = root.querySelectorAll("[data-theme-option]")
  var menu = root.querySelector("[data-theme-menu]")

  function setOpen(open) {
    if (!menu) return
    menu.hidden = !open
    if (button) button.setAttribute("aria-expanded", String(open))
  }
  function sync() {
    var stored = readStoredTheme()
    for (var i = 0; i < options.length; i += 1) {
      options[i].setAttribute("aria-pressed", String(options[i].getAttribute("data-theme-option") === stored))
    }
  }
  if (button && menu) button.addEventListener("click", function () { setOpen(menu.hidden) })
  for (var i = 0; i < options.length; i += 1) {
    (function (option) {
      option.addEventListener("click", function () {
        var value = option.getAttribute("data-theme-option")
        applyTheme(value)
        storeTheme(value)
        sync()
        setOpen(false)
      })
    })(options[i])
  }
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && menu && !menu.hidden) {
      setOpen(false)
      if (button) button.focus()
    }
  })
  document.addEventListener("click", function (event) {
    if (menu && !menu.hidden && !root.contains(event.target)) setOpen(false)
  })
  sync()
}

// Language picker: one compact control showing the ACTIVE language only; opening it reveals an
// overlay menu with both languages (the active one marked). Same overlay contract as the theme
// picker: it never pushes the page and closes on pick, Escape or an outside click.
function wireLang() {
  var root = document.querySelector("[data-lang-picker]")
  if (!root) return
  var button = root.querySelector("[data-lang-menu-button]")
  var menu = root.querySelector("[data-lang-menu]")

  function setOpen(open) {
    if (!menu) return
    menu.hidden = !open
    if (button) button.setAttribute("aria-expanded", String(open))
  }
  if (button && menu) button.addEventListener("click", function () { setOpen(menu.hidden) })
  if (menu) {
    menu.addEventListener("click", function (event) {
      if (event.target.closest("a")) setOpen(false)
    })
  }
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && menu && !menu.hidden) {
      setOpen(false)
      if (button) button.focus()
    }
  })
  document.addEventListener("click", function (event) {
    if (menu && !menu.hidden && !root.contains(event.target)) setOpen(false)
  })
}

window.addEventListener("DOMContentLoaded", () => { openHash(); wireCopy(); wireNav(); wireTheme(); wireLang() })
window.addEventListener("hashchange", openHash)
