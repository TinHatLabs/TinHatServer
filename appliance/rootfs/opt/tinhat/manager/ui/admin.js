// admin.js — the dashboard: Overview · Invites · People · Network · Maintenance.
"use strict";

const app = $("#app");
let me = null;
let tab = (location.hash || "#overview").slice(1);
let refreshTimer = 0;

function setMeta() {
  const meta = $("#meta");
  meta.replaceChildren();
  if (!me) return;
  meta.append(h("div", me.serverName), h("button.btn.ghost.small", { onclick: signOut }, "Sign out"));
  meta.classList.add("row");
}

async function signOut() {
  await api("/admin/api/logout", { method: "POST" }).catch(() => {});
  me = null;
  setMeta();
  viewLogin(null, { signedOut: true });
}

// ---- sign in -----------------------------------------------------------------------------------------------------

/** The Tin Hat Web session in this browser (same origin), if there is one. */
function appSession() {
  try {
    const c = JSON.parse(localStorage.getItem("tinhat.session") || "null");
    if (c && c.accessToken && c.userId && (!c.hsUrl || c.hsUrl.replace(/\/+$/, "") === location.origin)) return c;
  } catch {
    /* no session */
  }
  return null;
}

function viewLogin(msg, opts = {}) {
  const err = h("div.error", { role: "alert", class: msg ? "error" : "error hidden" }, msg || "");
  // Tin Hat's own sign-in in this browser can open the dashboard too, but not right after signing out of it or after
  // a password reset: then the password form is what's wanted (round 6).
  const sess = opts.signedOut || msg ? null : appSession();
  const cont = sess ? h("button.btn.cta.block", { type: "button" }, `Continue as ${sess.userId}`) : null;
  if (cont) {
    cont.addEventListener("click", async () => {
      cont.disabled = true;
      err.classList.add("hidden");
      try {
        await api("/admin/api/login-token", { json: { token: sess.accessToken } });
        await boot();
      } catch (ex) {
        cont.disabled = false;
        err.textContent = ex.message;
        err.classList.remove("hidden");
      }
    });
  }
  const user = h("input", { type: "text", autocomplete: "username", autocapitalize: "none", spellcheck: "false" });
  const pw = h("input", { type: "password", autocomplete: "current-password" });
  const go = h("button.btn.cta.block", { type: "submit" }, "Sign in");
  app.replaceChildren(h("div.shell", h("form.card.stack-lg", {
    onsubmit: async (e) => {
      e.preventDefault();
      go.disabled = true;
      err.classList.add("hidden");
      try {
        await api("/admin/api/login", { json: { username: user.value.trim(), password: pw.value } });
        await boot();
      } catch (ex) {
        go.disabled = false;
        err.textContent = ex.message;
        err.classList.remove("hidden");
        pw.select();
      }
    },
  },
  h("div.stack-sm", h("h1", "Server dashboard"), h("p.lede", cont ? "You're signed in to Tin Hat in this browser, as an admin of this server." : "Sign in with your Tin Hat admin account.")),
  opts.signedOut && appSession() ? h("div.note.small", "You're signed out of the dashboard. Tin Hat itself is still signed in in this browser: on a shared computer, sign out there too.") : null,
  cont,
  cont ? h("p.small.muted", "Or sign in with a different admin account:") : null,
  h("label.field", h("span", "Username"), user),
  h("label.field", h("span", "Password"), pw),
  err, go,
  h("p.small.muted.center", h("a", { href: "#", onclick: (e) => {
    e.preventDefault();
    app.replaceChildren(h("div.shell", recoverCard((mxid) => viewLogin(`Password changed for ${mxid}. Sign in with the new one.`), () => viewLogin())));
  } }, "Forgot your password?")))));
  if (cont) cont.focus();
  else user.focus();
  api("/admin/setup/status").then((st) => {  // a server that moved away: its chat server stopped, so sign-in can't work
    if (!st.moved) return;
    const form = app.querySelector("form");
    if (form) form.prepend(h("div.note.bad", `This server moved to another computer: it was restored there from a backup, so chat and calls stopped here and signing in here doesn't work. Use the new computer's dashboard: https://${st.serverName}/admin. You can switch this computer off.`));
  }).catch(() => {});
}

// ---- shell + tabs --------------------------------------------------------------------------------------------------

const TABS = [["overview", "Overview"], ["invites", "Invites"], ["people", "People"], ["network", "Network"], ["maintenance", "Maintenance"]];

function viewMain() {
  editingFeatures = false;
  if (!TABS.some(([id]) => id === tab)) tab = "overview";
  const body = h("div", { id: "tabbody" });
  const bar = h("div.tabs", { role: "tablist" }, TABS.map(([id, label]) =>
    h("button", { role: "tab", "aria-selected": String(id === tab), onclick: () => goTab(id) }, label)));
  app.replaceChildren(bar, body);
  clearTimeout(refreshTimer);
  ({ overview: tabOverview, invites: tabInvites, people: tabPeople, network: tabNetwork, maintenance: tabMaintenance })[tab](body);
}

/** Switch tabs through the address bar, so Back and Forward move between tabs too. */
function goTab(id) {
  if (location.hash === `#${id}`) { tab = id; viewMain(); return; }
  location.hash = id;  // the hashchange listener below shows it
}
window.addEventListener("hashchange", () => {
  const id = (location.hash || "#overview").slice(1);
  if (!me || id === tab && document.getElementById("tabbody")) return;
  tab = id;
  viewMain();
});

function loading(el) {
  el.replaceChildren(h("div.card", h("div.row", h("div.spin"), h("p.muted", "Loading…"))));
}

function failed(el, ex, retry) {
  if (ex.status === 401) return viewLogin("Your session ended. Sign in again.");
  el.replaceChildren(h("div.card.stack", h("div.error", ex.message), h("button.btn.ghost", { onclick: retry }, "Try again")));
}

// ---- overview ------------------------------------------------------------------------------------------------------

/** Where everyone finds this server's Tin Hat: the owner sees it every time, and passes it on. */
function whereCard(o) {
  const sn = o.serverName || "";
  const web = (o.api && o.api.web) || sn;
  const url = `https://${web}`;
  const home = sn.endsWith(".local");
  const short = typedName(sn, me && me.zone);
  return h("div.card.flat.row.wrap",
    h("div.grow.stack-sm",
      h("h3", "Your group's Tin Hat"),
      h("p", h("a.mono", { href: `${url}/` }, url), home
        ? " on your home network: each device there trusts the server once, then opens it in a browser, on a computer or a phone, or uses the Tin Hat app."
        : `: anyone opens it in a browser, on a computer or a phone, with nothing to install (typing just ${web} also works in browsers that try https first), or uses the Tin Hat app with “${short}” as the server.`),
      h("p.small.muted", "Tell your friends. To create an account they need an invite code: Invite someone gives them a link that fills it in.")),
    h("div.row.wrap", h("button.btn.ghost.small", { type: "button", onclick: () => copy(url, "Address") }, "Copy the address")));
}

async function tabOverview(el, quiet) {
  if (!quiet) loading(el);
  let o;
  try {
    o = await api("/admin/api/overview");
  } catch (ex) {
    return failed(el, ex, () => tabOverview(el));
  }
  if (tab !== "overview") return;
  if (quiet && (editingFeatures || editingApi || editingGames)) return; // someone started editing while this loaded
  const bad = o.services.filter((s) => !s.ok);
  const watch = o.watch || [];
  const serious = watch.some((w) => w.level === "bad");
  const p = o.probe;
  const memUsed = p.memory.total - p.memory.available;
  const diskUsed = p.disk.total - p.disk.free;
  const meter = (used, total) => {
    const pct = Math.min(100, Math.round((100 * used) / Math.max(1, total)));
    const i = h("i");
    i.style.width = `${pct}%`;
    return h("div.meter", h("div.bar", i));
  };
  const up = p.uptime > 86400 ? `${Math.floor(p.uptime / 86400)} d ${Math.floor((p.uptime % 86400) / 3600)} h` : `${Math.floor(p.uptime / 3600)} h ${Math.floor((p.uptime % 3600) / 60)} min`;
  el.replaceChildren(h("div.stack",
    h("div.card.row.wrap",
      h("div.grow.stack-sm",
        h("h2", o.moved ? "This server moved to another computer" : bad.length ? `${bad.length} part${bad.length === 1 ? "" : "s"} of the server need${bad.length === 1 ? "s" : ""} attention`
          : serious ? "Running, but something needs a look" : "Everything is running"),
        h("p.muted", o.moved ? "It was restored there from a backup, so chat and calls stopped here and the other computer has the name. You can switch this one off; its copy stays on its disk."
          : bad.length ? "Open Maintenance to restart them."
          : `${o.serverName} is ${serious ? "running" : "healthy"}. ${plural(o.counts.people, "person", "people")}, ${o.counts.rooms === null || o.counts.rooms === undefined ? "?" : plural(o.counts.rooms, "room", "rooms")}.`),
        watch.length ? h("div.stack-sm", watch.map((w) => h(`div.note${w.level === "bad" ? ".bad" : ""}`, w.text, " ",
          h("a", { href: "#maintenance", onclick: (e) => { e.preventDefault(); goTab("maintenance"); } }, "Maintenance")))) : null),
      h("div.row.wrap",
        h("a.btn.ghost", { href: `https://${(o.api && o.api.web) || o.serverName}/` }, "Open Tin Hat"),
        h("button.btn.cta", { onclick: () => goTab("invites") }, "Invite someone"))),
    o.moved ? null : whereCard(o),
    h("div.grid2",
      h("div.card.flat.stack-sm",
        h("h3", "Services"),
        h("div.list", o.services.map((s) => h("div.item", h("div.grow", h("div.k", s.label), h("div.s", statusText(s))),
          h(`span.chip.${s.ok ? "good" : "bad"}`, h("span.dot"), s.ok ? "Running" : "Stopped"))))),
      h("div.card.flat.stack",
        h("h3", "Resources"),
        h("div", h("div.row.between", h("span", "Memory"), h("span.muted.small", `${gb(memUsed)} of ${gb(p.memory.total)}`)), meter(memUsed, p.memory.total)),
        h("div", h("div.row.between", h("span", "Storage"), h("span.muted.small", `${gb(diskUsed)} of ${gb(p.disk.total)}`)), meter(diskUsed, p.disk.total)),
        h("dl.kv",
          h("dt", "Processor"), h("dd", `${p.cpu.cores} cores · load ${p.load[0]}`),
          h("dt", "Up for"), h("dd", up),
          h("dt", "Address"), h("dd.mono", p.addresses.join(", ") || "—"),
          h("dt", "Internet"), h("dd", p.online ? "connected" : "not connected")))),
    h("div.grid2",
      h("div.card.flat.stack-sm",
        h("h3", "What this server can do"),
        h("div.list", o.advice.verdicts.map((v) => h("div.item", h(`span.chip.${v.level}`, h("span.dot"), { good: "Good", warn: "OK", bad: "Low", info: "Note" }[v.level]), h("div.grow", v.text))))),
      featureCard(o, el)),
    h("div.grid2", apiCard(o, el), reportsCard(o)),
    gameServersCard(el),
    h("div.small.muted", "Measured at setup: ", o.advice.checks.filter((c) => c.id !== "internet").map((c) => `${c.label.toLowerCase()} ${c.value}`).join(" · "))));
  refreshTimer = setTimeout(function again() {
    if (tab !== "overview") return;
    if (editingFeatures || editingApi || editingGames) refreshTimer = setTimeout(again, 15000); // never throw away a half-made change
    else tabOverview(el, true);
  }, 15000);
}

let editingFeatures = false;

const UPLOADS = [25, 100, 500, 2000];
const upText = (mb) => (mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`);

/** The Features card: what the server runs, and a Change mode that applies new choices on the server. */
function featureCard(o, el) {
  const card = h("div.card.flat.stack-sm");
  const view = () => {
    editingFeatures = false;
    card.replaceChildren(
      h("div.row.between", h("h3", "Features"), o.features ? h("button.btn.ghost.small", { type: "button", onclick: edit }, "Change") : null),
      h("div.list", featureRows(o.features)));
  };
  const edit = () => {
    editingFeatures = true;
    const f = { ...o.features };
    const sw = (key, label, note, disabled) => {
      const b = h("button.switch", { type: "button", role: "switch", "aria-checked": String(!!f[key]), "aria-label": label, disabled });
      b.addEventListener("click", () => {
        f[key] = !f[key];
        b.setAttribute("aria-checked", String(f[key]));
      });
      return h("div.item", h("div.grow", h("div.k", label), note ? h("div.s", note) : null), b);
    };
    const sel = h("select", { "aria-label": "Biggest file people can send" }, UPLOADS.map((v) => h("option", { value: String(v), selected: v === f.uploadMb ? "" : null }, upText(v))));
    sel.addEventListener("change", () => (f.uploadMb = Number(sel.value)));
    const err = h("div.error.hidden", { role: "alert" });
    const save = h("button.btn.cta.small", { type: "button" }, "Save changes");
    const note = h("p.small.muted", "Saving restarts the chat server if needed (about 20 seconds); people see a short reconnect.");
    save.addEventListener("click", async () => {
      save.disabled = true;
      save.replaceChildren(h("span.spin"), "Applying…");
      err.classList.add("hidden");
      try {
        const r = await api("/admin/api/features", { json: f });
        o.features = r.features || f;
        editingFeatures = false;
        toast(r.changed && r.changed.length ? "Saved" : "Nothing changed");
        tabOverview(el, true);
      } catch (ex) {
        save.disabled = false;
        save.textContent = "Save changes";
        err.textContent = ex.message;
        err.classList.remove("hidden");
      }
    });
    card.replaceChildren(
      h("div.row.between", h("h3", "Change features"), h("button.btn.ghost.small", { type: "button", onclick: view }, "Cancel")),
      h("div.list",
        sw("calls", "Voice and video calls", "Off stops the call service; everything else keeps working."),
        sw("previews", "Link previews", o.probe.online ? "The server fetches pages for the apps." : "Needs the server to be online.", !o.probe.online && !f.previews),
        h("div.item", h("div.grow", h("div.k", "Biggest file people can send")), sel),
        sw("directory", "Find people by name", "Everyone on the server can find everyone else.")),
      note, err, h("div.row.end", save));
  };
  view();
  return card;
}

/** Docker's "Up About a minute (healthy)" in plain words. */
function statusText(s) {
  return (s.status || s.state || "").replace(/^Up About /, "Up about ").replace(/ \(healthy\)$/, "");
}

function featureRows(f) {
  if (!f) return [h("div.item", h("div.grow.muted", "Chosen before setup had a features step."))];
  const up = f.uploadMb >= 1000 ? `${f.uploadMb / 1000} GB` : `${f.uploadMb} MB`;
  return [
    ["Voice and video calls", f.calls ? "On" : "Off", f.calls],
    ["Link previews", f.previews ? "On" : "Off", f.previews],
    ["Biggest file people can send", up, true],
    ["Find people by name", f.directory ? "On" : "Off", f.directory],
  ].map(([k, v, on]) => h("div.item", h("div.grow", h("div.k", k)), h(`span.chip${on ? ".good" : ""}`, v)));
}

let editingApi = false;
const API_KEYS = [["giphy", "GIFs (Giphy key)"], ["youtube", "YouTube search (key)"], ["steam", "Steam library import (key)"], ["sgdb", "Game cover art (SteamGridDB key)"]];

/** Extras and keys: the Tin Hat API on this server — the owner's own keys, Memories, a TURN server, game servers. */
function apiCard(o, el) {
  const card = h("div.card.flat.stack-sm");
  const a = o.api || {};
  const keys = a.keys || {};
  const view = () => {
    editingApi = false;
    const rows = [
      ...API_KEYS.map(([k, label]) => [label, keys[k] ? "Set" : "Not set", !!keys[k]]),
      ["Memories (call recordings)", a.memories ? `On · ${a.recorder}` : "Off", !!a.memories],
      ["Phone notifications", a.phonePush === false ? "Off" : a.phoneRelay ? `On · through ${a.phoneRelay}` : "On, but no relay is set: phones get none",
        a.phonePush !== false && !!a.phoneRelay],
      ["Game servers panel", a.gameservers ? "Configured" : "Not configured", !!a.gameservers],
      ["TURN server for calls", a.turn ? `${a.turn.host}:${a.turn.port} (${a.turn.protocol})` : "None", !!a.turn],
      ...(a.webOffered ? [["Web app address", a.web || `${a.serverName} (the server's own)`, !!a.web]] : []),
    ];
    card.replaceChildren(
      h("div.row.between", h("h3", "Extras and keys"), h("button.btn.ghost.small", { type: "button", onclick: edit }, "Change")),
      h("div.list", rows.map(([k, v, on]) => h("div.item", h("div.grow", h("div.k", k)), h(`span.chip${on ? ".good" : ""}`, v)))),
      h("p.small.muted", "The soundboard, presence, push notifications and the games catalogue are always on. The keys are free: Giphy (developers.giphy.com), a YouTube Data API key (Google Cloud), Steam (steamcommunity.com/dev/apikey), SteamGridDB (steamgriddb.com)."));
  };
  const edit = () => {
    editingApi = true;
    const f = {};
    const keyItems = API_KEYS.map(([k, label]) => {
      const inp = h("input", { type: "password", placeholder: keys[k] ? "set — paste a new key to replace it" : "paste the key", autocomplete: "off" });
      inp.addEventListener("input", () => { f[`${k}Key`] = inp.value.trim(); });
      const clear = keys[k] ? h("button.btn.ghost.small", { type: "button" }, "Remove") : null;
      if (clear) clear.addEventListener("click", () => { f[`${k}Key`] = ""; inp.value = ""; inp.placeholder = "removed when you save"; inp.disabled = true; clear.disabled = true; });
      return h("div.item", h("div.grow", h("div.k", label), inp), clear);
    });
    let mem = !!a.memories;
    const memSw = h("button.switch", { type: "button", role: "switch", "aria-checked": String(mem), "aria-label": "Memories" });
    memSw.addEventListener("click", () => { mem = !mem; memSw.setAttribute("aria-checked", String(mem)); });
    const recIn = h("input", { type: "text", value: a.recorder || "", placeholder: "@recorder:your.server", autocomplete: "off", spellcheck: "false" });
    let phone = a.phonePush !== false;
    const phoneSw = h("button.switch", { type: "button", role: "switch", "aria-checked": String(phone), "aria-label": "Phone notifications" });
    phoneSw.addEventListener("click", () => { phone = !phone; phoneSw.setAttribute("aria-checked", String(phone)); });
    const turn = a.turn || {};
    const tHost = h("input", { type: "text", value: turn.host || "", placeholder: "turn.example.com (empty = none)", spellcheck: "false" });
    const tPort = h("input", { type: "text", value: turn.port ? String(turn.port) : "", placeholder: "3478 or 5349" });
    const tProto = h("select", { "aria-label": "TURN protocol" }, ["udp", "tcp", "tls"].map((p) => h("option", { value: p, selected: p === (turn.protocol || "udp") ? "" : null }, p)));
    const tUser = h("input", { type: "text", value: turn.username || "", placeholder: "user name", autocomplete: "off" });
    const tCred = h("input", { type: "password", placeholder: a.turn ? "credential (kept unless you type a new one)" : "credential (its password)", autocomplete: "off" });
    const webIn = a.webOffered ? h("input", { type: "text", value: a.web || "", placeholder: `${a.serverName} (empty = the server's own)`, autocomplete: "off", spellcheck: "false" }) : null;
    const err = h("div.error.hidden", { role: "alert" });
    const save = h("button.btn.cta.small", { type: "button" }, "Save changes");
    save.addEventListener("click", async () => {
      save.disabled = true;
      save.replaceChildren(h("span.spin"), "Applying…");
      err.classList.add("hidden");
      const body = { ...f, memories: mem, recorder: recIn.value.trim(), phonePush: phone, ...(webIn ? { web: webIn.value.trim() } : {}) };
      body.turn = tHost.value.trim()
        ? { host: tHost.value.trim(), port: tPort.value.trim(), protocol: tProto.value, username: tUser.value.trim(), credential: tCred.value }
        : null;
      try {
        const r = await api("/admin/api/features/api", { json: body });
        o.api = r.api || o.api;
        editingApi = false;
        toast(r.changed && r.changed.length ? "Saved" : "Nothing changed");
        tabOverview(el, true);
      } catch (ex) {
        save.disabled = false;
        save.textContent = "Save changes";
        err.textContent = ex.message;
        err.classList.remove("hidden");
      }
    });
    card.replaceChildren(
      h("div.row.between", h("h3", "Extras and keys"), h("button.btn.ghost.small", { type: "button", onclick: view }, "Cancel")),
      h("div.list", ...keyItems,
        h("div.item", h("div.grow", h("div.k", "Memories (call recordings)"),
          h("div.s", "Recordings a Tin Hat recorder writes into this server's recordings folder. Name the recorder's account, so the apps don't show it as a caller."), recIn), memSw),
        h("div.item", h("div.grow", h("div.k", "Phone notifications"),
          h("div.s", `Lets the Tin Hat iPhone and Android apps get notifications from this server. Each one is encrypted on this server for that phone and travels through the Tin Hat project's relay (${a.phoneRelay || "push.tinhat.dev"}) to Apple or Google; the relay sees only scrambled data and the phone's push address, never who wrote what. Off: phones get no notifications from this server.`)), phoneSw),
        h("div.item", h("div.grow", h("div.k", "TURN server for calls"),
          h("div.s", "For callers whose network blocks UDP (a coturn of your own). Leave the host empty for none."),
          h("div.row.wrap", tHost, tPort, tProto), h("div.row.wrap", tUser, tCred))),
        webIn ? h("div.item", h("div.grow", h("div.k", "Web app address"),
          h("div.s", "Only if your domain's front page is another website of yours: the address where your reverse proxy sends everything to this server (like tinhat.example.com). Guest links and the guest room's hand-off go there."), webIn)) : null),
      h("p.small.muted", "Saving restarts the extras (a few seconds; calls keep going). The game-servers panel is set up in a file for now (docs/API.md)."),
      err, h("div.row.end", save));
  };
  view();
  return card;
}

let editingGames = false;
/** Game servers: the owner's Pelican/Pterodactyl panel, which servers the apps' widget shows, the address players type
 *  and the space whose members see it (gameservers.py writes the API's two files). */
function gameServersCard(el) {
  const card = h("div.card.flat.stack-sm");
  let d = null;
  let gen = 0; // bumps on every step change: an answer for an abandoned step is dropped
  editingGames = false; // a new card: nothing half-made in it (an old card's edit, left by switching tabs, is gone)
  const load = async () => {
    try {
      d = await api("/admin/api/features/gameservers");
    } catch (ex) {
      card.replaceChildren(h("h3", "Game servers"), h("p.small.muted", ex.message));
      return;
    }
    if (!editingGames) view();
  };
  const spaceName = (id) => ((d.spaces || []).find((s) => s.id === id) || {}).name || id;
  const view = () => {
    editingGames = false;
    gen += 1;
    if (!d.configured) {
      card.replaceChildren(
        h("div.row.between", h("h3", "Game servers"), h("button.btn.ghost.small", { type: "button", onclick: step1 }, "Set up")),
        h("p.small.muted", "Run game servers with Pelican or Pterodactyl? The apps can show them in a widget: who's on, the join address and password, and a start button for the people you trust. You need the panel's address and an API key."));
      return;
    }
    card.replaceChildren(
      h("div.row.between", h("h3", "Game servers"),
        h("div.row", h("button.btn.ghost.small", { type: "button", onclick: step1 }, "Change"), h("button.btn.ghost.small", { type: "button", onclick: removeIt }, "Remove"))),
      h("div.list", d.servers.map((s) => h("div.item", h("div.grow", h("div.k", s.label || s.game), h("div.s", `${d.kinds[s.kind] || s.kind}${s.outside ? " · friends outside can join" : " · home network only"}`))))),
      h("p.small.muted", `Players join at ${d.joinHost}. Shown to the members of ${spaceName(d.space)}. Panel: ${d.url}.`));
  };
  const removeIt = async (ev) => {
    const b = ev.currentTarget;
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Remove the widget?"; return; }
    try { d = { ...d, ...(await api("/admin/api/features/gameservers", { method: "DELETE" })) }; toast("Removed"); view(); } catch (ex) { toast(ex.message); }
  };
  const err = () => h("div.error.hidden", { role: "alert" });
  const fail = (box, ex) => { box.textContent = ex.message; box.classList.remove("hidden"); };
  const step1 = () => {
    editingGames = true;
    const mine = ++gen;
    const url = h("input", { type: "text", inputmode: "url", value: d.url || "", placeholder: "https://panel.example.com", spellcheck: "false" });
    const key = h("input", { type: "password", placeholder: d.keySet ? "set — paste a new key to replace it" : "the client API key (pacc_…)", autocomplete: "off" });
    const e = err();
    const go = h("button.btn.cta.small", { type: "button" }, "Connect");
    go.addEventListener("click", async () => {
      const asked = { url: url.value.trim(), key: key.value.trim() || null }; // the key tested is the key saved
      go.disabled = true; url.disabled = true; key.disabled = true;
      go.replaceChildren(h("span.spin"), "Asking the panel…"); e.classList.add("hidden");
      try {
        const found = await api("/admin/api/features/gameservers/connect", { json: asked });
        if (mine === gen) step2(found, asked.key);
      } catch (ex) {
        if (mine !== gen) return;
        go.disabled = false; url.disabled = false; key.disabled = false; go.textContent = "Connect"; fail(e, ex);
      }
    });
    card.replaceChildren(
      h("div.row.between", h("h3", "Game servers"), h("button.btn.ghost.small", { type: "button", onclick: view }, "Cancel")),
      h("div.list",
        h("div.item", h("div.grow", h("div.k", "The panel's address"), h("div.s", "As this server reaches it (on the home network it can be the panel's local address)."), url)),
        h("div.item", h("div.grow", h("div.k", "API key"),
          h("div.s", "Best: a user of its own on the panel with access to just these servers (Control: console, start, stop, restart; Startup: read), then Account → API Credentials → a key allowed only from this server's address."), key))),
      e, h("div.row.end", go));
  };
  const step2 = (found, newKey) => {
    gen += 1;
    const have = new Map((d.servers || []).map((s) => [s.uuid, s]));
    const pwKinds = new Set(d.passwordVarKinds || []);
    const seen = new Set(found.servers.map((s) => s.uuid));
    // configured servers this key doesn't show (a permission gone, another key): kept, ticked, and said so
    const missing = (d.servers || []).filter((s) => !seen.has(s.uuid)).map((s) => ({ uuid: s.uuid, name: s.label || s.game, egg: "", kind: s.kind, node: "", missing: true }));
    const all = [...found.servers, ...missing];
    const preselectAll = !d.configured && found.servers.length <= 32;
    const rows = all.map((s) => {
      const old = have.get(s.uuid) || {};
      const on = h("input", { type: "checkbox", checked: have.has(s.uuid) || preselectAll ? "" : null, "aria-label": `Show ${s.name}` });
      const game = h("input", { type: "text", value: old.game || s.name, maxlength: "64", "aria-label": "Game" });
      const kind = h("select", { "aria-label": "Which game" }, Object.entries(d.kinds).map(([k, label]) => h("option", { value: k, selected: k === (old.kind || s.kind) ? "" : null }, label)));
      const pw = h("input", { type: "text", value: old.joinPasswordText || "", placeholder: "join password (if any)", maxlength: "64", "aria-label": "Join password" });
      const showPw = () => pw.classList.toggle("hidden", pwKinds.has(kind.value)); // the panel has that password itself
      kind.addEventListener("change", showPw); showPw();
      const out = h("input", { type: "checkbox", checked: old.outside ? "" : null });
      const info = h("input", { type: "text", value: old.info || "", placeholder: "a line for players (optional)", maxlength: "280", "aria-label": "Note" });
      return { s, on, game, kind, pw, out, info,
        el: h("div.item", on, h("div.grow.stack-sm", h("div.k", s.name, h("span.small.muted", s.missing ? " · this key doesn't see it (still listed until you untick it)" : s.egg ? ` · ${s.egg}` : "")),
          h("div.row.wrap", game, kind, pw), info, h("label.small", out, " Friends outside the home can join (its port is forwarded)"))) };
    });
    const join = h("input", { type: "text", value: d.joinHost || "", placeholder: "games.example.com", spellcheck: "false" });
    const listed = (d.spaces || []).some((sp) => sp.id === d.space);
    const space = h("select", { "aria-label": "Space" }, h("option", { value: "" }, "Choose a space…"),
      d.space && !listed ? h("option", { value: d.space, selected: "" }, `The current space (${d.space})`) : null,
      (d.spaces || []).map((sp) => h("option", { value: sp.id, selected: sp.id === d.space ? "" : null }, `${sp.name} (${sp.members})`)));
    const wings = h("input", { type: "text", value: d.wings || found.wings || "", placeholder: "wss://node.example.com:8080", spellcheck: "false", "aria-label": "Wings websocket" });
    const origin = h("input", { type: "text", value: d.origin || found.origin, placeholder: "https://panel.example.com", spellcheck: "false", "aria-label": "The panel's public address" });
    const e = err();
    const save = h("button.btn.cta.small", { type: "button" }, "Save");
    save.addEventListener("click", async () => {
      e.classList.add("hidden");
      const picked = rows.filter((r) => r.on.checked);
      if (picked.length > 32) return fail(e, new Error(`Pick up to 32 servers (${picked.length} are ticked).`));
      const nodes = new Set(picked.map((r) => r.s.node).filter(Boolean));
      if (nodes.size > 1) return fail(e, new Error(`These servers run on ${nodes.size} different panel nodes (${[...nodes].join(", ")}); the widget talks to one node for now. Tick servers of one node.`));
      save.disabled = true; save.replaceChildren(h("span.spin"), "Saving…");
      // the configured Wings address wins (it may be the LAN one); with none, the picked servers' own node
      const wingsVal = !d.wings && nodes.size === 1 && wings.value.trim() === (found.wings || "") ? [...nodes][0] : wings.value.trim();
      const body = { url: found.url, wings: wingsVal, origin: origin.value.trim(), joinHost: join.value.trim(), space: space.value,
        announceRoom: d.announceRoom || null,
        servers: picked.map((r) => ({ uuid: r.s.uuid, game: r.game.value.trim(), kind: r.kind.value, info: r.info.value.trim(),
          outside: r.out.checked, joinPasswordText: pwKinds.has(r.kind.value) ? "" : r.pw.value })) }; // a password exactly as typed
      if (newKey) body.key = newKey;
      try {
        d = { ...d, ...(await api("/admin/api/features/gameservers", { json: body })) };
        toast("Saved: the apps show the widget within a minute");
        view();
      } catch (ex) { save.disabled = false; save.textContent = "Save"; fail(e, ex); }
    });
    card.replaceChildren(
      h("div.row.between", h("h3", "Game servers"), h("button.btn.ghost.small", { type: "button", onclick: view }, "Cancel")),
      h("p.small.muted", `The panel at ${found.url} shows ${found.servers.length} server${found.servers.length === 1 ? "" : "s"}. Tick the ones the widget shows (up to 32, on one panel node).`),
      d.testOverrides ? h("p.small.muted", `The settings file also gives ${d.testOverrides} test group${d.testOverrides === 1 ? "" : "s"} access through another space; they stay only while "Who sees them" stays the same.`) : null,
      d.spacesComplete === false ? h("p.small.muted", "The list of spaces couldn't be read in full; the current choice is kept.") : null,
      h("div.list", rows.map((r) => r.el)),
      h("div.list",
        h("div.item", h("div.grow", h("div.k", "The address players type"), h("div.s", "Each server adds its own port."), join)),
        h("div.item", h("div.grow", h("div.k", "Who sees them"), h("div.s", "The members of this space see the widget. Who can start and stop the servers is a role permission in the space (\"Manage game servers\"); without roles, its admins."), space)),
        h("div.item", h("div.grow", h("div.k", "Wings and the panel's public address"), h("div.s", "Filled in from the panel; change them only if its nodes are reached by another name."), h("div.row.wrap", wings, origin)))),
      e, h("div.row.end", save));
  };
  card.replaceChildren(h("h3", "Game servers"), h("p.small.muted", "Loading…"));
  load();
  return card;
}

/** Reports: what people sent this server with "Report a problem", "Share logs" and "Report…" (a person or a message:
 * an abuse report, from the Tin Hat API or, for guests and other Matrix apps, Synapse's own; docs/ACCOUNT-SAFETY.md). */
function reportsCard(o) {
  const card = h("div.card.flat.stack-sm");
  const n = (o.api && o.api.reports) || 0;
  const web = (o.api && o.api.web) || o.serverName || "";
  const list = h("div.list");
  const when = (at) => new Date(at * 1000).toLocaleString();
  // the room or the message in the web app (the owner opens it signed in as themselves; nothing is fetched here)
  const openLink = (room, event) => room && web ? h("a.btn.ghost.small", { href: `https://${web}/#/room/${encodeURIComponent(room)}${event ? "/" + encodeURIComponent(event) : ""}`, target: "_blank", rel: "noopener" }, event ? "Open the message" : "Open the room") : null;
  const download = (it) => h("a.btn.ghost.small", { href: `/admin/api/reports/file?kind=${it.kind}&name=${encodeURIComponent(it.name)}` }, "Download");
  const abuseItem = (who, reporter, at, category, details, room, event, extra, more) => h("div.item",
    h("div.grow",
      h("div.k", h("span.chip.bad", "Abuse report"), " ", category ? `${category}: ` : "", who || (event ? "a message" : "?")),
      h("div.s", `from ${reporter || "?"} · ${when(at)}${event ? " · a message" : ""}${extra ? ` · ${extra}` : ""}`),
      details ? h("div.s", `“${details}”`) : null),
    openLink(room, event), more || null);
  const row = (it) => {
    if (it.source === "matrix") return abuseItem(it.reported_user, it.user, it.at, "", it.reason, it.room_id, it.event_id, `through Matrix${it.room ? ` in ${it.room}` : ""}`);
    if (it.abuse) {
      const a = it.abuse;
      return abuseItem(a.reported_user, it.user, it.at, a.category, a.details, a.room_id, a.event_id, "", download(it));
    }
    return h("div.item",
      h("div.grow", h("div.k", it.kind === "report" ? (it.title || "Problem report") : `Log: ${it.name.split("-").slice(4).join("-") || it.name}`),
        h("div.s", `${it.user || "?"} · ${when(it.at)} · ${Math.max(1, Math.round(it.size / 1024))} KB`)),
      download(it));
  };
  const load = async () => {
    try {
      const r = await api("/admin/api/reports");
      const all = [...r.reports, ...(r.matrix || []).map((m) => ({ ...m, source: "matrix" }))].sort((a, b) => b.at - a.at);
      // one odd entry never hides the others
      const safe = (it) => { try { return row(it); } catch { return h("div.item", h("div.grow.muted", `A report this page can't show (${it.name || it.id || "?"})`)); } };
      const notes = [];
      if (r.matrix === null) notes.push(h("div.item", h("div.grow.muted", "Reports sent through Matrix couldn't be read just now (is chat running?). Refresh to try again.")));
      else if (r.matrixTotal > r.matrix.length) notes.push(h("div.item", h("div.grow.muted", `Showing the newest ${r.matrix.length} of ${r.matrixTotal} reports sent through Matrix.`)));
      list.replaceChildren(...(all.length ? all.map(safe)
        : [h("div.item", h("div.grow.muted", "Nothing yet. People send these from the app's Report a problem, Share logs and Report…; they stay on this server."))]), ...notes);
    } catch (ex) {
      list.replaceChildren(h("div.item", h("div.grow.muted", ex.message)));
    }
  };
  card.replaceChildren(h("div.row.between", h("h3", `Reports${n ? ` (${n})` : ""}`), h("button.btn.ghost.small", { type: "button", onclick: load }, "Refresh")), list);
  load();
  return card;
}

// ---- invites -------------------------------------------------------------------------------------------------------

function shareText(code, sn, web) {
  if (!sn.endsWith(".local")) {  // from anywhere: a real address, so the link does everything
    const short = typedName(sn, me && me.zone);
    return `You're invited to “${short}”, our Tin Hat server.\n` +
      `Open https://${web || sn}/#/register?token=${encodeURIComponent(code)} to create your account (the invite code ${code} is filled in).\n` +
      `After that, our Tin Hat is always at https://${web || sn} in any browser.\n` +
      `In the Tin Hat app, choose “Create an account”, type “${short}” as the server and enter the same code.`;
  }
  return `You're invited to ${sn}, our Tin Hat server.\n` +
    `1. On our home network, open http://${sn} and follow the two steps there.\n` +
    `2. In Tin Hat, choose "Create an account" and enter the invite code ${code}.`;
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast("Couldn't copy — select it and copy it yourself");
  }
}

async function tabInvites(el) {
  loading(el);
  let data;
  try {
    data = await api("/admin/api/invites");
  } catch (ex) {
    return failed(el, ex, () => tabInvites(el));
  }
  const sn = data.server;
  const web = data.web || "";  // the web app's own address, when the server's name is another website's front page
  let uses = 1;
  let days = 7;
  const seg = (opts, get, set) => {
    const wrap = h("div.seg", { role: "group" });
    const draw = () => wrap.replaceChildren(...opts.map(([v, label]) =>
      h("button", { type: "button", "aria-pressed": String(get() === v), onclick: () => { set(v); draw(); } }, label)));
    draw();
    return wrap;
  };
  const result = h("div");
  const create = h("button.btn.cta", { type: "button" }, "Create invite code");
  create.addEventListener("click", async () => {
    create.disabled = true;
    try {
      const r = await api("/admin/api/invites", { json: { uses, days } });
      const code = r.invite.code;
      result.replaceChildren(h("div.stack",
        h("div.codebox", h("div.grow", h("div.small.muted", "New invite code"), h("div.code", { "data-code": code }, code)),
          h("button.btn.ghost.small", { onclick: () => copy(code, "Code") }, "Copy code")),
        h("div.note.stack-sm", h("div.small.muted", "Send this to your friend:"), h("div", { "data-share": "" }, ...shareText(code, sn, web).split("\n").flatMap((l, i) => (i ? [h("br"), l] : [l])))),
        h("div.row.wrap", h("button.btn.ghost.small", { onclick: () => copy(shareText(code, sn, web), "Invitation") }, "Copy invitation"))));
      await drawList();
    } catch (ex) {
      if (ex.status === 401) return viewLogin("Your session ended. Sign in again.");
      result.replaceChildren(h("div.error", ex.message));
    } finally {
      create.disabled = false;
    }
  });
  const list = h("div");
  const drawList = async () => {
    let d = data;
    try {
      d = await api("/admin/api/invites");
    } catch {
      /* keep the last list */
    }
    data = d;
    if (!d.invites.length) {
      list.replaceChildren(h("div.empty", "No invite codes yet."));
      return;
    }
    list.replaceChildren(h("div.list", d.invites.map((inv) => {
      const used = inv.completed + inv.pending;
      const left = inv.usesAllowed == null ? "unlimited uses" : `${used} of ${inv.usesAllowed} used`;
      const exp = inv.expiresAt == null ? "never expires" : inv.expiresAt < d.now ? `expired ${dateText(inv.expiresAt)}` : `expires ${dateText(inv.expiresAt)}`;
      const chip = inv.active ? h("span.chip.good", "Active") : inv.usesAllowed != null && used >= inv.usesAllowed ? h("span.chip", "Used") : h("span.chip", "Expired");
      const revoke = h("button.btn.danger.small", { type: "button" }, inv.active ? "Revoke" : "Remove");
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try {
          await api(`/admin/api/invites/${encodeURIComponent(inv.code)}`, { method: "DELETE" });
          toast(`${inv.code} removed`);
          await drawList();
        } catch (ex) {
          revoke.disabled = false;
          toast(ex.message);
        }
      });
      const share = inv.active ? h("button.btn.ghost.small", { type: "button", onclick: () => copy(shareText(inv.code, sn, web), "Invitation") }, "Copy invitation") : null;
      return h("div.item", h("div.grow", h("div.k.mono", inv.code), h("div.s", `${left} · ${exp}`)), chip, share, revoke);
    })));
  };
  el.replaceChildren(h("div.stack",
    data.adminHasAppDevice === false ? h("div.note.stack-sm",
      h("b", "Open Tin Hat yourself first."),
      h("span", " Messages are encrypted for the devices that exist when they're sent, so anything your friends write before you've ever signed in to Tin Hat can't be read by you later."),
      h("div.row", h("a.btn.ghost.small", { href: `https://${web || sn}/` }, "Open Tin Hat"))) : null,
    h("div.card.stack-lg",
      h("div.stack-sm", h("h2", "Invite someone"), h("p.muted", "An invite code lets one person (or a few) create an account on this server."),
        sn.endsWith(".local") ? null : h("p.small", "Everyone uses your Tin Hat in any browser at ", h("a", { href: `https://${web || sn}/` }, `https://${web || sn}`),
          ", or in the Tin Hat app.")),
      h("div.row.wrap",
        h("div.stack-sm", h("div.small.muted", "Who can use it"), seg([[1, "1 person"], [5, "5 people"], [0, "Anyone with the code"]], () => uses, (v) => (uses = v))),
        h("div.stack-sm", h("div.small.muted", "Expires"), seg([[1, "1 day"], [7, "7 days"], [30, "30 days"], [0, "Never"]], () => days, (v) => (days = v)))),
      h("div.row", create),
      result),
    h("div.card.flat.stack-sm", h("h3", "Invite codes"), list)));
  if (data.adminHasAppDevice === false) {  // signed in to Tin Hat in another tab meanwhile: look again on coming back
    window.addEventListener("focus", () => { if (tab === "invites" && el.isConnected) tabInvites(el, true); }, { once: true });
  }
  await drawList();
}

// ---- people --------------------------------------------------------------------------------------------------------

async function tabPeople(el) {
  loading(el);
  let d;
  try {
    d = await api("/admin/api/people");
  } catch (ex) {
    return failed(el, ex, () => tabPeople(el));
  }
  const initial = (n) => (n || "?").replace(/^@/, "").slice(0, 1).toUpperCase();
  el.replaceChildren(h("div.card.flat.stack-sm",
    h("div.row.between", h("h3", `${d.people.filter((p) => !p.deactivated).length} people`), h("span.small.muted", "Everyone with an account on this server")),
    d.people.length ? h("div.list", d.people.map((p) => {
      const mine = me && me.mxid === p.mxid;
      const panel = h("div.stack-sm.pwpanel.hidden");
      const btn = p.deactivated || mine ? null
        : h("button.btn.ghost.small", { type: "button", onclick: () => { panel.classList.toggle("hidden"); if (!panel.childNodes.length) newPasswordPanel(panel, p); } }, "New password");
      return h("div.stack-sm",
        h("div.item",
          h("span.ico.done", initial(p.name)),
          h("div.grow", h("div.k", p.name), h("div.s.mono", p.mxid)),
          p.admin ? h("span.chip.accent", "Admin") : null,
          p.deactivated ? h("span.chip", "Removed") : null,
          h("div.s.small.muted", p.lastSeen ? `seen ${ago(p.lastSeen)}` : `joined ${dateText(p.created)}`),
          btn),
        panel);
    })) : h("div.empty", "Nobody yet."),
    h("p.small.muted", "Forgot a password? This server sends no email, so you set a new one here: New password next to the " +
      "person. Your own password: in the Tin Hat app, Settings → Devices & security → Change password.")));
}

/** People → New password: the server makes one, the owner hands it over; the person picks their own in the app. */
function newPasswordPanel(panel, p) {
  const out = h("input", { type: "checkbox" });
  const err = h("div.error.hidden");
  const go = h("button.btn.small", { type: "button" }, "Set a new password");
  const cancel = h("button.btn.ghost.small", { type: "button", onclick: () => panel.classList.add("hidden") }, "Cancel");
  go.addEventListener("click", async () => {
    go.disabled = true;
    err.classList.add("hidden");
    try {
      const r = await api("/admin/api/people/password", { json: { mxid: p.mxid, signOutEverywhere: out.checked } });
      panel.replaceChildren(
        h("div.codebox", h("div.grow", h("div.small.muted", `${p.name}'s new password`), h("div.code", r.password)),
          h("button.btn.ghost.small", { type: "button", onclick: () => copy(r.password, "Password") }, "Copy")),
        h("p.small.muted", "It works right away and is shown only now. Give it to them in person or in a message only they read. " +
          "They sign in with it, then choose their own in the Tin Hat app: Settings → Devices & security → Change password." +
          (r.signedOut ? " Their devices were signed out." : " Devices they're signed in on stay signed in.")),
        h("div.row", h("button.btn.ghost.small", { type: "button", onclick: () => { panel.replaceChildren(); panel.classList.add("hidden"); } }, "Done")));
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
      go.disabled = false;
    }
  });
  panel.replaceChildren(
    h("p.small", `Set a new password for ${p.name}? The server makes one for you to give them. Their old password stops working.`),
    h("label.row.small", out, h("span", "Also sign them out on every device (only if someone else may know the old password). " +
      "They'll need their Security Key to read their old messages there again.")),
    err,
    h("div.row", go, cancel));
}

// ---- maintenance ---------------------------------------------------------------------------------------------------

async function tabMaintenance(el) {
  loading(el);
  let o;
  try {
    o = await api("/admin/api/overview");
  } catch (ex) {
    return failed(el, ex, () => tabMaintenance(el));
  }
  el.replaceChildren(h("div.stack",
    h("div.card.flat.stack-sm",
      h("h3", "Services"),
      h("p.small.muted", "Restarting a part of the server takes a few seconds. People in a call may drop for a moment."),
      h("div.list", o.services.map((s) => {
        const b = h("button.btn.ghost.small", { type: "button" }, "Restart");
        b.addEventListener("click", async () => {
          b.disabled = true;
          b.replaceChildren(h("span.spin"), "Restarting…");
          try {
            await api(`/admin/api/services/${s.id}/restart`, { method: "POST" });
            toast(`${s.label} restarted`);
          } catch (ex) {
            toast(ex.message);
          }
          tabMaintenance(el);
        });
        return h("div.item", h("div.grow", h("div.k", s.label), h("div.s", statusText(s))), h(`span.chip.${s.ok ? "good" : "bad"}`, s.ok ? "Running" : "Stopped"), b);
      }))),
    h("div.grid2",
      updatesCard(),
      backupsCard()),
    moveCard(),
    helpCard(),
    sshCard(),
    (o.serverName || "").endsWith(".local") ? h("div.card.flat.stack-sm",
      h("h3", "This server's certificate"),
      h("p.small.muted", "New devices need to trust it once. They can also get it from the server's welcome page, http://" + o.serverName + "."),
      h("div.row.wrap", h("a.btn.ghost.small", { href: "/admin/ca.crt", download: "" }, "Download certificate"))) : null,
    h("div.card.flat.stack-sm",
      h("h3", "About"),
      h("dl.kv",
        h("dt", "Server"), h("dd", o.serverName),
        h("dt", "Tin Hat Server"), h("dd", o.version),
        h("dt", "Tin Hat Web"), h("dd", o.webVersion || "—"),
        h("dt", "Set up"), h("dd", o.installedAt ? dateText(Date.parse(o.installedAt)) : "—")))));
}

// ---- network: the server's address, whether friends outside can reach it, notices from the names service -----------

const KIND_TEXT = {
  public: "Your home has its own public address.",
  cgnat: "Your internet provider shares its public address between many homes (carrier NAT).",
  "double-nat": "Two routers in a row (your provider's box, then your own).",
  "upstream-nat": "Something past your router translates addresses too.",
  unknown: "Your router didn't say what kind of connection this is.",
  direct: "This server has its own public address: there's no router in between.",
};

// ---- the Tin Hat relay: friends reach a server behind carrier NAT through it (relay.py on the server) --------------

/** Relay traffic, in the names service's units (1 GB = 1000³ bytes, so a 100 GB allowance reads "100 GB"). */
function traffic(bytes) {
  const b = bytes || 0;
  if (b < 1e9) return `${Math.round(b / 1e6)} MB`;
  return b < 1e10 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e9)} GB`;
}

function usageBar(used, quota) {
  const fill = h("i");
  fill.style.width = `${Math.min(100, Math.round((100 * used) / quota))}%`; // CSSOM, not a style attribute (CSP)
  return h("div.bar", fill);
}

function relayCard(n, el) {
  const r = n.relay || {};
  const p = n.ports || {};
  const level = (n.summary || {}).level;
  const err = h("div.error.hidden");
  const fail = (ex) => { err.textContent = ex.message; err.classList.remove("hidden"); };
  if (!r.on) {
    const cgnat = p.kind === "cgnat";
    if (!r.available || (!cgnat && level === "good")) return null; // only for tinhat.me names, while a relay is there
    const go = h("button.btn.cta", { type: "button" }, "Use the Tin Hat relay");
    go.addEventListener("click", async () => {
      go.disabled = true;
      go.replaceChildren(h("span.spin"), "Connecting to the relay… (calls pause for a few seconds)");
      err.classList.add("hidden");
      try {
        await api("/admin/api/network/relay", { json: { on: true } });
        toast("Connected through the Tin Hat relay");
        tabNetwork(el, true);
      } catch (ex) { fail(ex); go.disabled = false; go.textContent = "Use the Tin Hat relay"; }
    });
    return h("div.card.stack",
      h("h2", cgnat ? "Use the Tin Hat relay" : "Can't change your router's settings?"),
      h("p", cgnat ? "Your internet provider doesn't allow incoming connections, so no router setting can let friends in. The Tin Hat relay can."
        : "The Tin Hat relay lets friends in without opening any ports on your router."),
      h("p.muted", "Your server keeps a connection open to the relay, and friends reach your server through it. Your server keeps its own certificate, so the relay passes everything on without being able to read it. People at home still connect straight to the server for calls."),
      h("div.row.wrap", go), err);
  }
  const used = r.usedBytes || 0;
  const quota = r.quotaBytes || 0;
  const tunnel = r.tunnelOk ? `Up${r.rttMs ? ` · ${Math.round(r.rttMs)} ms to the relay` : ""}`
    : r.downSince ? `Down since ${ago(r.downSince * 1000)}` : "Not answering";
  const state = { active: ["good", "Connected"], "calls-paused": ["warn", "Calls paused"], paused: ["bad", "Paused"], suspended: ["bad", "Paused by Tin Hat"] }[r.status] || ["good", "Connected"];
  const [lvl, label] = r.tunnelOk ? state : ["bad", "Tunnel down"];
  const off = h("button.btn.ghost", { type: "button" }, "Turn off the relay");
  const cgnatHere = p.kind === "cgnat";
  const offWhat = h("div.note.hidden", cgnatHere
    ? "Without the relay, friends outside can't reach your server. Your internet provider doesn't allow incoming connections, so this dashboard won't open by its name either, not even at home. To turn the relay back on later, open "
    : "Without the relay, friends outside reach your server only once your router's ports are free for it (Network tab, Router). If this dashboard doesn't open by its name afterwards, open ",
    h("span.mono", `http://${(n.serverName || "").split(".")[0]}.local`), " on your home network and sign in there.");
  off.addEventListener("click", async () => {
    if (off.dataset.sure !== "1") { off.dataset.sure = "1"; off.textContent = "Yes, turn it off"; offWhat.classList.remove("hidden"); return; }
    off.disabled = true;
    err.classList.add("hidden");
    try {
      await api("/admin/api/network/relay", { json: { on: false } });
      offWhat.replaceChildren("The relay is turning off. If you're not at home, this page can't reach your server any more: that's expected.");
      setTimeout(() => tabNetwork(el, true).catch(() => {}), 8000);
    } catch (ex) { fail(ex); off.disabled = false; }
  });
  return h("div.card.stack",
    h("div.row.wrap.between", h("h2", "Tin Hat relay"), h(`span.chip.${lvl}`, h("span.dot"), label)),
    h("p", "Reachable through the Tin Hat relay."),
    h("p.muted", (cgnatHere ? "Your internet provider doesn't allow incoming connections, so friends outside reach your server through the relay. "
      : "Friends outside reach your server through the relay. ") + "It passes their traffic on without being able to read it: your server's certificate and its key never leave this server."),
    h("dl.kv",
      h("dt", "Friends connect to"), h("dd.mono", r.relayAddress || "—"),
      h("dt", "Calls through the relay"), h("dd.mono", r.port ? `TCP + UDP ${r.port}` : "—"),
      h("dt", "Tunnel"), h("dd", tunnel),
      h("dt", "This month"), h("dd", quota ? `${traffic(used)} of ${traffic(quota)}` : used ? traffic(used) : "—"),
      r.since ? h("dt", "Since") : null, r.since ? h("dd", dateText(r.since * 1000)) : null),
    quota ? usageBar(used, quota) : null,
    r.error ? h("div.note.bad", r.error) : null,
    h("div.row.wrap", off), offWhat, err);
}

/** Behind the owner's reverse proxy: which address(es) count as the proxy. Named, nobody else on the home network may
 * connect to the proxy port or say who the caller is (the sign-in limits count that address). Never set by itself:
 * the server shows where the proxy connects from and offers it. */
function proxyTrustCard(px, el) {
  const named = px.trusted || [];
  const input = h("input", { type: "text", value: named.join(", "), placeholder: px.peer || "192.168.1.5", autocomplete: "off", spellcheck: "false", "aria-label": "Your reverse proxy's address" });
  const err = h("div.error.hidden");
  const save = h("button.btn", { type: "button" }, "Save");
  const send = async (addresses) => {
    save.disabled = true;
    err.classList.add("hidden");
    try {
      await api("/admin/api/network/proxy", { json: { addresses } });
      toast(addresses.length ? "Only your proxy connects now" : "Any home-network address counts as your proxy again");
      tabNetwork(el, true);
    } catch (ex) { err.textContent = ex.message; err.classList.remove("hidden"); save.disabled = false; }
  };
  save.addEventListener("click", () => send(input.value.split(/[\s,]+/).filter(Boolean)));
  const use = px.peer && !named.includes(px.peer)
    ? h("button.btn.ghost", { type: "button", onclick: () => send([...named, px.peer]) }, `Use ${px.peer}`) : null;
  const clear = named.length ? h("button.btn.ghost", { type: "button", onclick: () => send([]) }, "Any home-network address") : null;
  return h("div.card.stack",
    h("div.row.wrap.between", h("h2", "Who counts as your proxy"),
      h(`span.chip.${named.length ? "good" : "muted"}`, h("span.dot"), named.length ? named.join(", ") : "Any home-network address")),
    h("p.muted", named.length
      ? "Only these addresses may connect to this server's port " + px.port + " and tell it who the visitor is."
      : "Right now any device on your home network may connect to port " + px.port + " and tell this server who the visitor is, so a device at home could dodge the sign-in limits. Name your proxy to close that."),
    px.peer ? h("p.small", "This page reached the server through ", h("span.mono", px.peer), ".") : null,
    h("label.field", h("span", "Your reverse proxy's address"), input,
      h("small", "The address your proxy connects to this server from; several with commas. A small network (like 192.168.1.0/28) works too.")),
    h("div.row.wrap", save, use, clear), err);
}

async function tabNetwork(el, quiet) {
  if (!quiet) loading(el);
  let n;
  try {
    n = await api("/admin/api/network");
  } catch (ex) {
    return failed(el, ex, () => tabNetwork(el));
  }
  if (tab !== "network") return;
  if (!publicMode(n.mode)) {
    el.replaceChildren(h("div.card.stack",
      h("h2", "Home network"),
      h("p.muted", `${n.serverName} is set up for people on this home network. Nothing is opened to the internet.`),
      h("p.muted", "Reaching it from anywhere needs a new server name under tinhat.me, which this version sets up only during a fresh install.")));
    return;
  }
  const sm = n.summary || {};
  const level = sm.level === "good" ? "good" : sm.level === "warn" ? "warn" : "bad";
  const p = n.ports || {};
  const r = n.reach || {};
  const checkBtn = h("button.btn.ghost", { type: "button" }, "Check again");
  const err = h("div.error.hidden");
  checkBtn.addEventListener("click", async () => {
    checkBtn.disabled = true;
    checkBtn.textContent = "Checking… (calls pause for a few seconds)";
    err.classList.add("hidden");
    try {
      await api("/admin/api/network/check", { json: {} });
      tabNetwork(el, true);
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
      checkBtn.disabled = false;
      checkBtn.textContent = "Check again";
    }
  });
  const relayed = !!(n.relay && n.relay.on);
  const res = r.results || {};
  // A port the router wouldn't open for us can still reach us: forwarded by hand in its settings, say. The last
  // outside check (443, 7881, 7882) is the evidence, and only for what it was: a direct check (not through the relay)
  // of the address the router has now. It is history, so the chip says "at the last check" (Check again refreshes it),
  // and it never outvotes the router naming another device as the port's holder. Port 80 only lets friends type the
  // bare name, so missing it is no warning.
  const sameHome = r.via !== "relay" && !!r.public_ip && r.public_ip === p.public_ip;
  const reachedOutside = (m) => {
    const key = { "TCP 443": "tls443", "TCP 7881": "tcp7881", "UDP 7882": "udp7882" }[`${m.proto} ${m.port}`];
    return !!(sameHome && key && res[key] && res[key].ok);
  };
  const portRows = relayed ? [] : (p.mapped || []).map((m) => {
    const reached = !m.taken && reachedOutside(m);
    const optional = m.proto === "TCP" && m.port === 80;
    const [cls, text] = m.ok ? ["good", "Opened by the router"]
      : reached ? ["good", "Reachable at the last check"]
      : m.taken ? [optional ? "muted" : "warn", m.holder ? `Sent to ${m.holder}` : "Used by another device"]
      : [optional ? "muted" : "warn", optional ? "Not opened automatically (optional)" : (m.why || "Not opened")];
    return h("div.item", h("div.grow", h("div.k", `${m.proto} ${m.port}`),
      h("div.s", m.port === 443 ? "the app, chat and call sign-in" : optional ? "friends typing just the name"
        : m.proto === "UDP" ? "calls (sound and video)" : "calls, when UDP is blocked")),
      h(`span.chip.${cls}`, h("span.dot"), text));
  });
  const refused = (p.mapped || []).filter((m) => !m.ok && !(m.proto === "TCP" && m.port === 80));
  const byHand = !relayed && refused.length > 0 && refused.every((m) => !m.taken && reachedOutside(m));
  const auto = p.method === "upnp" ? "UPnP" : p.method === "natpmp" ? "NAT-PMP" : "";
  const outRows = ["tls443", "tcp7881", "udp7882"].filter((k) => res[k]).map((k) => [k, res[k]]).map(([k, v]) => h("div.item",
    h("div.grow", h("div.k", relayed ? { tls443: "HTTPS (TCP 443) at the relay", tcp7881: `Calls over TCP (relay port ${n.relay.port})`, udp7882: `Calls over UDP (relay port ${n.relay.port})` }[k] || k
      : { tls443: "HTTPS (TCP 443)", tcp7881: "Calls over TCP (7881)", udp7882: "Calls over UDP (7882)" }[k] || k),
      v.ok ? null : h("div.s", { unreachable: "Nothing answered from outside.", certificate: "The certificate isn't valid yet.", "no-answer": "No answer from outside.", "wrong-answer": "Something else answered." }[v.why] || v.why || "")),
    h(`span.chip.${v.ok ? "good" : "bad"}`, h("span.dot"), v.ok ? "Reachable" : "Blocked")));
  const notices = (n.notices || []).map((x) => h(`div.note${x.level === "error" ? ".bad" : ""}`, x.text));
  if (n.names && n.names.unreachable_since && n.names.status !== "moved") {
    notices.unshift(h("div.note", `This server hasn't reached the Tin Hat names service since ${dateText(n.names.unreachable_since * 1000)}: ` +
      "either this home's internet connection is down, or the names service is. Friends keep reaching the server at its " +
      "current address; if your home's address changes before the names service answers again, friends outside can't " +
      "find the server until it does. It keeps trying every ten minutes."));
  }
  if (n.names && n.names.status === "moved") {
    notices.unshift(h("div.note.bad", "This server's name moved to another computer: it was restored there from a backup. " +
      "Chat and calls stopped here, and this computer let go of your router's ports, so friends reach the other one. " +
      "When the other one works, switch this one off."));
  }
  el.replaceChildren(h("div.stack",
    notices.length ? h("div.card.stack", h("h2", "From the Tin Hat names service"), ...notices,
      h("div.row.end", h("button.btn.ghost", { onclick: async () => { await api("/admin/api/network/notices-seen", { json: {} }); tabNetwork(el, true); } }, "Dismiss"))) : null,
    h("div.card.stack",
      h("div.row.wrap.between", h("h2", "Friends outside"), h(`span.chip.${level}`, h("span.dot"), level === "good" ? "Reachable" : level === "warn" ? "Partly" : "Not reachable")),
      h("p", sm.headline || "Not checked yet."),
      ...(sm.lines || []).map((l) => h("p.muted", l)),
      (sm.fix || []).length ? h("div.stack-sm", h("div.k", "In your router's settings (often its phone app):"), h("ul.fix", sm.fix.map((f) => h("li", f)))) : null,
      h("div.row.wrap", checkBtn, h("span.small.muted", r.at ? `Last checked ${ago(r.at * 1000)}` : "")),
      err),
    n.domain ? domainCard(n) : null,
    n.proxy ? proxyCard(n.proxy) : null,
    n.proxy ? proxyTrustCard(n.proxy, el) : null,
    relayCard(n, el),
    h("div.grid2",
      h("div.card.flat.stack-sm",
        h("h3", "Address"),
        h("dl.kv",
          h("dt", "Server"), h("dd.mono", n.serverName),
          h("dt", "Friends type"), h("dd.mono", typedName(n.serverName, me && me.zone)),
          relayed ? h("dt", "Friends connect to") : h("dt", "Public address"),
          h("dd.mono", relayed ? `${n.relay.relayAddress} (the relay)` : (n.names && n.names.ip4) || (n.domain && n.domain.home) || r.public_ip || p.public_ip || "—"),
          relayed ? h("dt", "Your home's public address") : null, relayed ? h("dd.mono", r.public_ip || p.public_ip || "—") : null,
          n.domain ? null : h("dt", "Name status"), n.domain ? null : h("dd", (n.names && n.names.status === "active") ? "active" : ((n.names && n.names.status) || "—")),
          h("dt", p.kind === "direct" ? "This server" : "This server at home"), h("dd.mono", p.lan_ip || (n.addresses || [])[0] || "—"))),
      h("div.card.flat.stack-sm",
        h("h3", "Router"),
        h("p.muted", KIND_TEXT[p.kind] || KIND_TEXT.unknown),
        h("dl.kv",
          h("dt", "Router"), h("dd", p.kind === "direct" ? "none" : p.router ? ([p.router.maker, p.router.model].filter(Boolean).join(" ") || p.router.name) : relayed ? "not asked (the relay needs nothing from it)" : "didn't answer"),
          p.gateway ? h("dt", "Its settings") : null, p.gateway ? h("dd.mono", `http://${p.gateway}`) : null,
          h("dt", "Its ports"), h("dd", relayed ? "none needed: the relay carries friends' traffic" : p.kind === "direct" ? "none needed: this server has its own public address"
            : auto ? (byHand ? `opened automatically (${auto}) where the router allowed it; the others were reachable at the last check` : `opened automatically (${auto})`) : "set by hand in the router")),
        portRows.length ? h("div.list", portRows) : null)),
    outRows.length ? h("div.card.flat.stack-sm", h("h3", "Last check from outside"), h("div.list", outRows)) : null,
    connectionsCard(el)));
}

/** The owner's own domain: where it points now, next to where the home is, and who keeps that current. */
function domainCard(n) {
  const d = n.domain;
  const points = d.resolves || [];
  const home = d.home || d.ip4;
  const ok = !!home && points.includes(home);
  const where = d.provider === "proxy" ? "At your domain's DNS provider" : `In your ${d.label} settings`;
  return h("div.card.flat.stack-sm",
    h("div.row.wrap.between", h("h3", "Your domain"), home ? h(`span.chip.${ok ? "good" : d.keepsAddress ? "warn" : "bad"}`, h("span.dot"), ok ? "Points home" : "Points elsewhere") : null),
    h("dl.kv",
      h("dt", "DNS"), h("dd", d.provider === "proxy" ? "at your domain's provider (HTTPS by your own reverse proxy)" : d.label || d.provider || "—"),
      h("dt", `${n.serverName} points to`), h("dd.mono", points.length ? points.join(", ") : "nothing yet"),
      h("dt", "Your home is at"), h("dd.mono", home || "not known right now")),
    d.error ? h("div.note.bad", `The last change through ${d.label} failed: ${d.error}`) : null,
    !home ? null : ok
      ? h("p.small.muted", d.keepsAddress ? `This server keeps it pointing at your home through ${d.label} (it checks every ten minutes).`
        : "It points at your home. If your home's address changes, change the record too; your router's dynamic DNS can do that for you.")
      : d.keepsAddress ? h("div.note", `This server points it at your home through ${d.label} within ten minutes; DNS answers can take a few more minutes to change.`)
        : h("div.note.bad", `${where}, point ${n.serverName} at ${home} (an A record). Until then friends' devices look for the server at the old address.`));
}

// ---- connections to other Tin Hat servers (federation by consent) -------------------------------------------------

function connectionsCard(netEl) {
  const card = h("div.card.stack", h("h2", "Other Tin Hat servers"), h("div.row", h("span.spin"), h("span.muted", "Loading…")));
  const other = h("div.card.stack", h("h2", "Other Matrix servers"), h("div.row", h("span.spin"), h("span.muted", "Loading…")));
  const short = (fq) => typedName(fq, me && me.zone);
  const render = async () => {
    let c;
    try {
      c = await api("/admin/api/connections");
    } catch (ex) {
      card.replaceChildren(h("h2", "Other Tin Hat servers"), h("div.error", ex.message));
      other.replaceChildren(h("h2", "Other Matrix servers"), h("div.error", ex.message));
      return;
    }
    renderAllowed(c);
    const err = h("div.error.hidden");
    const fail = (ex) => { err.textContent = ex.message; err.classList.remove("hidden"); };
    const list = c.connections.map((x) => {
      const btn = h("button.btn.ghost.small", { type: "button" }, "Disconnect");
      const what = h("div.s.hidden", "People on the two servers can't message or call each other until you connect again.");
      btn.addEventListener("click", async () => {
        if (btn.dataset.sure !== "1") { btn.dataset.sure = "1"; btn.textContent = "Yes, disconnect"; what.classList.remove("hidden"); return; }
        btn.disabled = true;
        try { await api(`/admin/api/connections/${encodeURIComponent(x.server)}`, { method: "DELETE" }); toast(`Disconnected from ${short(x.server)}`); render(); } catch (ex) { fail(ex); btn.disabled = false; }
      });
      return h("div.item.code", h("div.grow", h("div.k", short(x.server)), h("div.s.mono", `${x.server} · since ${dateText(x.since * 1000)}`), what), btn);
    });
    const codes = c.codes.map((x) => h("div.item.code",
      h("div.grow", h("div.k.mono", x.code), h("div.s", `Expires ${dateText(x.expires * 1000)}. Send it to the other server's owner, with this server's name: “${short(c.serverName)}”.`)),
      h("button.btn.ghost.small", { type: "button", onclick: () => copy(`Connect your Tin Hat server to “${short(c.serverName)}” with the code ${x.code} (Dashboard → Network → Connect to a server).`, "Connection code") }, "Copy"),
      h("button.btn.ghost.small", { type: "button", onclick: async () => { try { await api(`/admin/api/connections/codes/${x.code}`, { method: "DELETE" }); render(); } catch (ex) { fail(ex); } } }, "Cancel")));
    const make = h("button.btn.ghost", { type: "button" }, "Make a connection code");
    make.addEventListener("click", async () => { make.disabled = true; try { await api("/admin/api/connections/codes", { json: {} }); render(); } catch (ex) { fail(ex); make.disabled = false; } });
    const srv = h("input", { type: "text", placeholder: "their server, like crew", autocapitalize: "none", spellcheck: "false" });
    const code = h("input", { type: "text", placeholder: "TC-XXXX-XXXX", autocapitalize: "characters", spellcheck: "false" });
    const go = h("button.btn.cta", { type: "submit" }, "Connect");
    const form = h("form.stack-sm", {
      onsubmit: async (e) => {
        e.preventDefault();
        err.classList.add("hidden");
        go.disabled = true;
        go.textContent = "Connecting…";
        try {
          const r = await api("/admin/api/connections", { json: { server: srv.value.trim(), code: code.value.trim() } });
          toast(r.message);
          render();
        } catch (ex) { fail(ex); go.disabled = false; go.textContent = "Connect"; }
      },
    }, h("div.k", "Connect to a server"), h("div.row.wrap.end-items",
      h("label.field.inline", h("span", "Their server's name"), srv), h("label.field.inline", h("span", "Their connection code"), code), go));
    card.replaceChildren(...[
      h("h2", "Other Tin Hat servers"),
      h("p.muted", "Connect with a friend's Tin Hat server so people on both can message each other, share rooms and call. Both owners agree, and either can disconnect at any time. Your own rooms, like General, stay on this server."),
      !publicMode(c.mode) ? h("p.muted", "Connections need a server that's reachable from anywhere.") : null,
      c.applying ? h("div.note", "Restarting the chat server to apply a change… (a few seconds)") : null,
      list.length ? h("div.list", list) : h("p.small.muted", "Not connected to any other server."),
      publicMode(c.mode) ? h("div.stack-sm", codes.length ? h("div.list", codes) : null, h("div.row.wrap", make)) : null,
      publicMode(c.mode) ? form : null,
      err].filter(Boolean));
  };
  // Matrix servers that aren't Tin Hat: no connection code to swap, so the owner allows one by its name alone.
  const renderAllowed = (c) => {
    const err = h("div.error.hidden");
    const fail = (ex) => { err.textContent = ex.message; err.classList.remove("hidden"); };
    const rows = (c.allowed || []).map((x) => {
      const btn = h("button.btn.ghost.small", { type: "button" }, "Remove");
      const what = h("div.s.hidden", "People here and on that server can't message each other until you allow it again.");
      btn.addEventListener("click", async () => {
        if (btn.dataset.sure !== "1") { btn.dataset.sure = "1"; btn.textContent = "Yes, remove"; what.classList.remove("hidden"); return; }
        btn.disabled = true;
        try { const r = await api(`/admin/api/allowed-servers/${encodeURIComponent(x.server)}`, { method: "DELETE" }); toast(r.message); render(); } catch (ex) { fail(ex); btn.disabled = false; }
      });
      const since = x.by === "hand" ? "added by hand before the dashboard had this list" : `allowed ${dateText(x.since * 1000)}`;
      return h("div.item.code", h("div.grow", h("div.k.mono", x.server), h("div.s", since), what), btn);
    });
    const name = h("input", { type: "text", placeholder: "example.org", autocapitalize: "none", spellcheck: "false", maxlength: "300" });
    const go = h("button.btn.cta", { type: "submit" }, "Allow");
    const form = h("form.stack-sm", {
      onsubmit: async (e) => {
        e.preventDefault();
        err.classList.add("hidden");
        go.disabled = true;
        go.textContent = "Allowing…";
        try {
          const r = await api("/admin/api/allowed-servers", { json: { server: name.value.trim() } });
          toast(r.message);
          render();
        } catch (ex) { fail(ex); go.disabled = false; go.textContent = "Allow"; }
      },
    }, h("div.k", "Allow a Matrix server by name"), h("div.row.wrap.end-items",
      h("label.field.inline", h("span", "Its name"), name), go),
      h("p.small.muted", "The part after the colon in people's Matrix IDs: for @sam:example.org, type example.org."));
    other.replaceChildren(...[
      h("h2", "Other Matrix servers"),
      h("p.muted", "Tin Hat speaks Matrix, so people here can also talk with people on a Matrix server that isn't Tin Hat, like a friend's own server. Those servers don't use connection codes: allow one by its name. People on it can then message people here and share rooms with them, end-to-end encrypted as usual. Your own rooms, like General, stay on this server."),
      !publicMode(c.mode) ? h("p.muted", "Other servers need this one to be reachable from anywhere.") : null,
      c.applying ? h("div.note", "Restarting the chat server to apply a change… (a few seconds)") : null,
      rows.length ? h("div.list", rows) : h("p.small.muted", "No Matrix servers allowed."),
      publicMode(c.mode) ? form : null,
      err].filter(Boolean));
  };
  render();
  // Stay current without a reload: quickly while the chat server applies a change, otherwise now and then (the other
  // owner may have just connected with our code).
  let quiet = 0;
  const tick = setInterval(() => {
    if (!document.body.contains(card) || tab !== "network") return clearInterval(tick);
    quiet += 1;
    const busy = [card, other].some((el) => el.contains(document.activeElement) || [...el.querySelectorAll("input")].some((i) => i.value)
      || [...el.querySelectorAll("button")].some((b) => b.dataset.sure === "1"));
    if ((card.querySelector(".note") || other.querySelector(".note") || quiet % 5 === 0) && !busy) render();
  }, 3000);
  return [card, other];
}

// ---- boot ----------------------------------------------------------------------------------------------------------

async function boot() {
  try {
    me = await api("/admin/api/me");
  } catch (ex) {
    me = null;
    setMeta();
    if (ex.status === 401) return viewLogin();
    app.replaceChildren(h("div.card.stack", h("div.error", ex.message), h("button.btn.ghost", { onclick: boot }, "Try again")));
    return;
  }
  setMeta();
  viewMain();
}

boot();
