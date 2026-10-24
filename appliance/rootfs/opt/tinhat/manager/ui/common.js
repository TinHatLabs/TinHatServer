// common.js — shared by the setup wizard, the welcome page and the dashboard (no build step, no framework).
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/** JSON API call; throws Error(message from the server) on a non-2xx answer. */
async function api(path, opts = {}) {
  const init = { credentials: "same-origin", headers: { "X-Tinhat": "1" }, ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || "POST";
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  }
  let r;
  try {
    r = await fetch(path, init);
  } catch (e) {
    throw Object.assign(new Error("Can't reach the server. Is it still on, and is this device on the same network?"), { offline: true });
  }
  let body = {};
  try {
    body = await r.json();
  } catch {
    body = {};
  }
  if (!r.ok) throw Object.assign(new Error(body.error || `Something went wrong (error ${r.status}).`), { status: r.status, body });
  return body;
}

/** Build an element: h("div.card", {onclick}, "text", child, …). Text children are never parsed as HTML. */
function h(tag, attrs, ...kids) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v; // only ever used with our own static SVG markup
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICON = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  cross: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  dash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4.5 8h7"/></svg>',
  bigcheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  bigwarn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 6.5v7"/><path d="M12 17.6h.01"/></svg>',
};

/** Reachable from anywhere: a name under tinhat.me, or the owner's own domain. */
// Own-domain DNS providers: setup's "My own domain" and Maintenance → Move to your own domain.
const OWN_PROVIDERS = {
  cloudflare: { label: "Cloudflare", fields: [["token", "API token"]], help: "My Profile → API Tokens → Create Token, with two permissions for this domain's zone: Zone → Zone → Read and Zone → DNS → Edit. Tin Hat also keeps the domain pointing at your home." },
  porkbun: { label: "Porkbun", fields: [["apiKey", "API key"], ["secretKey", "Secret API key"]], help: "Account → API Access, and switch on API access for this domain. Point the domain at your home yourself (or with your router's dynamic DNS)." },
  desec: { label: "deSEC", fields: [["token", "Token"]], help: "Token Management → add a token. Point the domain at your home yourself." },
  duckdns: { label: "DuckDNS", fields: [["token", "Token"]], help: "The token on your DuckDNS page. The domain is one of yours under duckdns.org." },
  proxy: { label: "My own reverse proxy (it handles HTTPS)", fields: [], help: "For nginx, Traefik, Caddy or Nginx Proxy Manager that already has port 443 and gets its own certificates. This server listens on port 8080 for it, and asks your router only for the call ports. After installing, you get the settings to paste into your proxy." },
};

const publicMode = (m) => m === "anywhere" || m === "domain";
/** What people type in the Tin Hat app to find a server: the first part of a tinhat.me name, or a whole own domain. */
const typedName = (server, zone) => (server && zone && server.endsWith(`.${zone}`) ? server.split(".")[0] : server || "");

/** Behind the owner's own reverse proxy: where it should send the domain, and copyable settings for the common ones. */
function proxyCard(px) {
  const kinds = [["nginx", "nginx"], ["caddy", "Caddy"], ["traefik", "Traefik"], ["npm", "Nginx Proxy Manager"]];
  let cur = "nginx";
  const pre = h("pre.report.mono");
  const copyBtn = h("button.btn.ghost.small", { type: "button" }, "Copy");
  const seg = h("div.seg", { role: "group", "aria-label": "Settings for" });
  const draw = () => {
    pre.textContent = px.snippets[cur];
    for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.k === cur));
    copyBtn.textContent = "Copy";
  };
  for (const [k, label] of kinds) seg.append(h("button", { type: "button", "data-k": k, onclick: () => { cur = k; draw(); } }, label));
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      copyBtn.textContent = "Copied";
    } catch {
      const r = document.createRange();
      r.selectNodeContents(pre);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      copyBtn.textContent = "Selected: press Ctrl+C";
    }
  });
  draw();
  return h("div.card.stack",
    h("h2", "Your reverse proxy"),
    h("p.muted", `Send https://${px.serverName} to http://${px.lanIp}:${px.port} on your home network. Your proxy keeps the certificate. Calls don't go through it: TCP 7881 and UDP 7882 come straight to this server.`),
    h("div.row.wrap.between", seg, copyBtn),
    pre,
    h("p.small.muted", "Give this server a fixed address in your router (a DHCP reservation), so the proxy keeps finding it."));
}

/** Can this device open the server's public address? From inside the home that needs the router to loop traffic back
 * in ("NAT loopback"); many do, some don't. Fills `slot` with the answer and what to do. */
async function canOpen(sn) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    await fetch(`https://${sn}/.well-known/matrix/client`, { mode: "no-cors", cache: "no-store", signal: ctl.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

/** Retries a few times before saying no (right after a move or a new certificate, a device can need a moment), then
 * keeps trying quietly for a few minutes, so the warning goes away by itself once it works. */
async function homeReach(sn, slot, tries = 4) {
  const good = () => slot.replaceChildren(h("span.chip.good", h("span.dot"), "This device reaches your server"));
  clearInterval(slot._later);
  for (let i = 0; i < tries; i++) {
    if (await canOpen(sn)) return good(), true;
    if (i < tries - 1) {
      slot.replaceChildren(h("span.spin"), h("span.muted", ` Checking this device can open ${sn}…`));
      await new Promise((r) => setTimeout(r, 6000 + 4000 * i));
    }
  }
  slot.replaceChildren(h("span.chip.warn", h("span.dot"), "This device can't open it from here"),
    h("span.muted", " Either friends outside can't reach the server yet (see below), or your router doesn't loop traffic back into the home (\"NAT loopback\" or \"hairpin\"; turn it on in the router's settings). A phone on mobile data shows which."));
  let n = 0;
  slot._later = setInterval(async () => {
    if (!slot.isConnected || ++n > 10) return clearInterval(slot._later);
    if (await canOpen(sn)) { clearInterval(slot._later); good(); }
  }, 30000);
  return false;
}

function gb(bytes) {
  const g = bytes / 1024 ** 3;
  return g >= 10 ? `${Math.round(g)} GB` : `${g.toFixed(1)} GB`;
}

function ago(ms) {
  if (!ms) return "never";
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function dateText(ms) {
  return ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}

function dateTimeText(ms) {
  return ms ? new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
}

/** "1 room", "2 rooms". */
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

let toastTimer = 0;
function toast(text) {
  let t = $(".toast");
  if (!t) document.body.append((t = h("div.toast", { role: "status" })));
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

// ---- "Trust this server" (home-network mode) ----------------------------------------------------------------

/** Per-OS steps for trusting the server's certificate. `name` = the CA's display name. */
function trustInstructions(name) {
  const os = [
    ["Windows", [
      "Open the file you just downloaded and choose Install Certificate…",
      "Pick Current User, then Next.",
      "Choose “Place all certificates in the following store”, press Browse and pick Trusted Root Certification Authorities.",
      "Next, Finish, and Yes when Windows asks.",
      "Close every browser window and open it again.",
    ]],
    ["Mac", [
      "Open the file you just downloaded; Keychain Access opens.",
      `Double-click “${name}” in the login keychain.`,
      "Open Trust and set “When using this certificate” to Always Trust.",
      "Close the window and enter your Mac password.",
    ]],
    ["iPhone or iPad", [
      "Open this page in Safari and download the certificate; tap Allow.",
      "Open Settings → Profile Downloaded → Install (enter your passcode).",
      "Go to Settings → General → About → Certificate Trust Settings.",
      `Turn on “${name}”.`,
    ]],
    ["Android", [
      "Download the certificate.",
      "Open Settings and search for “CA certificate” (Security → More security settings → Install from device storage → CA certificate).",
      "Choose Install anyway and pick the downloaded file.",
    ]],
    ["Linux (Chrome, Chromium, Edge)", [
      "Open the browser's Settings → Privacy and security → Security → Manage certificates.",
      "Choose Local certificates → Installed by you, then Import next to Trusted certificates.",
      "Pick the file you downloaded, then close the browser and open it again.",
    ]],
    ["Firefox (any computer)", [
      "Settings → Privacy & Security → Certificates → View Certificates…",
      "Authorities → Import…, pick the downloaded file.",
      "Tick “Trust this CA to identify websites” and press OK.",
    ]],
  ];
  return h("div", os.map(([title, steps]) => h("details.os", h("summary", title), h("ol", steps.map((s) => h("li", s))))));
}

/** Watch whether this device trusts https://<server> yet; calls onChange(true|false) whenever it flips. */
function watchTrust(serverName, onChange) {
  let last = null;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    let ok = false;
    try {
      const r = await fetch(`https://${serverName}/.well-known/matrix/client`, { cache: "no-store", mode: "cors" });
      ok = r.ok;
    } catch {
      ok = false;
    }
    if (ok !== last) {
      last = ok;
      onChange(ok);
    }
    setTimeout(tick, ok ? 15000 : 3000);
  };
  tick();
  return () => (stopped = true);
}

/** "Open Tin Hat", held back until this device trusts the server — opening it earlier only shows the browser's red
 *  "not private" warning. A small "open anyway" stays available in case the check itself is what's wrong. */
function gatedOpen(href, label) {
  const btn = h("a.btn.cta", { href, "aria-disabled": "true" }, label);
  const hint = h("span.small.muted", "Do step 1 first — this button turns on when the device trusts the server.");
  const anyway = h("a.small", { href }, "Open anyway");
  btn.addEventListener("click", (e) => {
    if (btn.getAttribute("aria-disabled") === "true") {
      e.preventDefault();
      hint.classList.add("warn-text");
    }
  });
  const el = h("div.stack-sm", h("div.row.wrap", btn, h("span.small.muted.mono", href.replace(/\/$/, ""))), h("div.row.wrap", hint, anyway));
  return {
    el,
    setTrusted(ok) {
      btn.setAttribute("aria-disabled", ok ? "false" : "true");
      hint.classList.toggle("hidden", ok);
      anyway.classList.toggle("hidden", ok);
    },
  };
}

/** "Forgot your password?": the server shows a one-time code on its own screen; with it, an admin password can be
 * reset. Used by the dashboard's sign-in and the welcome page. onDone(mxid) runs after a successful reset. */
function recoverCard(onDone, onCancel) {
  const err = h("div.error.hidden", { role: "alert" });
  const fail = (m) => { err.textContent = m; err.classList.remove("hidden"); };
  const card = h("div.card.stack-lg");
  let own = false; // installed on the owner's own Linux machine: the code is a command away, not on a screen
  let win = false; // Tin Hat Server for Windows: the icon next to the clock shows it
  let cli = "sudo tinhat"; // the command that shows the codes on the owner's machine (Compose: docker exec …)
  const step1 = () => {
    const ask = h("button.btn.cta", { type: "button" }, own ? "Make a code" : "Show a code on the server's screen");
    ask.addEventListener("click", async () => {
      ask.disabled = true;
      err.classList.add("hidden");
      try {
        const r = await api("/admin/recover/start", { json: {} });
        step2(r.minutes);
      } catch (ex) { ask.disabled = false; fail(ex.message); }
    });
    card.replaceChildren(
      h("div.stack-sm", h("h1", "Forgot your password?"),
        h("p.lede", own ? "The server makes a one-time code that only someone on the machine itself can read. Type it here with a new password for your admin account."
          : win ? "The server can show a one-time code on the PC it runs on. Type it here with a new password for your admin account."
          : "The server can show a one-time code on its own screen. Type it here with a new password for your admin account.")),
      h("p.muted", own ? `On the server, run: ${cli} recovery-code`
        : win ? "The Tin Hat Server icon next to that PC's clock shows it (right-click it, then Show recovery code)."
        : "Its own screen is the monitor plugged into it, or its console window if it's a virtual machine. On Windows, right-click the Tin Hat Server icon next to the clock and choose Show recovery code."),
      err, h("div.row.end", onCancel ? h("button.btn.ghost", { type: "button", onclick: onCancel }, "Back") : null, ask));
  };
  const step2 = (minutes) => {
    const code = h("input.code", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "0000-0000", maxlength: "9", "aria-label": own || win ? "The recovery code" : "Code from the server's screen" });
    code.addEventListener("input", () => {
      const d = code.value.replace(/\D/g, "").slice(0, 8);
      code.value = d.length > 4 ? `${d.slice(0, 4)}-${d.slice(4)}` : d;
    });
    const user = h("input", { type: "text", autocomplete: "username", autocapitalize: "none", spellcheck: "false" });
    const p1 = h("input", { type: "password", autocomplete: "new-password" });
    const p2 = h("input", { type: "password", autocomplete: "new-password" });
    const out = h("input", { type: "checkbox" });
    const go = h("button.btn.cta", { type: "submit" }, "Set the new password");
    card.replaceChildren(h("form.stack-lg", {
      onsubmit: async (e) => {
        e.preventDefault();
        err.classList.add("hidden");
        if (p1.value.length < 8) return fail("Use a password of at least 8 characters.");
        if (p1.value !== p2.value) return fail("The two passwords don't match.");
        go.disabled = true;
        try {
          const r = await api("/admin/recover/finish", { json: { code: code.value, username: user.value, password: p1.value, logoutDevices: out.checked } });
          onDone(r.mxid);
        } catch (ex) { go.disabled = false; fail(ex.message); }
      },
    },
    h("div.stack-sm", h("h1", "Type the code"), h("p.lede", own ? `The code is ready: on the server, run ${cli} recovery-code. It works for ${minutes} minutes.`
      : win ? `The Tin Hat Server icon next to the server PC's clock shows the code now (right-click it, then Show recovery code). It works for ${minutes} minutes.`
      : `A code is on the server's own screen now. It works for ${minutes} minutes.`)),
    h("label.field", h("span", own || win ? "The recovery code" : "Code from the server's screen"), code),
    h("label.field", h("span", "Your admin username"), user),
    h("label.field", h("span", "New password"), p1),
    h("label.field", h("span", "The new password again"), p2),
    h("label.row.small", out, h("span", "Also sign out every device (if someone else may know the old password). You'll need your Security Key to read messages on them again.")),
    err, h("div.row.end", h("button.btn.ghost", { type: "button", onclick: step1 }, "Get a new code"), go)));
    code.focus();
  };
  step1();
  api("/admin/setup/status").then((st) => {
    const ownEd = st.edition === "linux" || st.edition === "compose";
    if ((ownEd && !own) || (st.platform === "windows" && !win)) {
      own = ownEd;
      cli = st.edition === "compose" ? "docker exec tinhat-manager tinhat" : "sudo tinhat";
      win = st.platform === "windows";
      if (!card.querySelector("input.code")) step1();
    }
  }).catch(() => {});
  return card;
}
