// maintenance.js — the dashboard's Maintenance cards that run the server's own upkeep: Updates, Backups, Move to your
// own domain, SSH, Get help.
// Loaded before admin.js; uses h(), api(), toast(), ago() and dateText() from common.js / admin.js.
"use strict";

const UPDATE_STEPS = {
  starting: "Starting the update…",
  images: "Downloading the new version's parts…",
  snapshot: "Making a safety copy (database and settings)…",
  switch: "Switching to the new version…",
  restart: "Starting everything again…",
  check: "Checking that everything works…",
  rollback: "Going back to the version that worked…",
};

/** Updates: what's installed, what's new, install now or tonight, and how the last one went. */
function updatesCard() {
  const card = h("div.card.flat.stack-sm", h("h3", "Updates"), h("div.row", h("span.spin"), h("span.muted", "Loading…")));
  let timer = 0;
  let seenVersion = null;
  let following = null; // the version installed when the owner pressed Install: follow until it changes or ends
  const render = (d) => {
    clearTimeout(timer);
    if (seenVersion !== null && !card.isConnected) return;  // the owner left the Maintenance tab
    const st = d.status || {};
    if (following && (d.installed !== following || ["done", "rolled-back", "broken", "current"].includes(st.phase))) following = null;
    const busy = ["downloading", "installing", "rolling-back"].includes(st.phase) || !!following;
    if (seenVersion && seenVersion !== d.installed) toast(`Updated to Tin Hat Server ${d.installed}`);
    seenVersion = d.installed;
    const chip = busy ? h("span.chip.accent", h("span.spin"), st.phase === "rolling-back" ? "Going back" : "Updating")
      : st.phase === "available" || st.phase === "staged" ? h("span.chip.warn", h("span.dot"), "Update available")
        : st.phase === "broken" ? h("span.chip.bad", h("span.dot"), "Needs attention")
          : st.phase === "rolled-back" ? h("span.chip.warn", h("span.dot"), "Went back")
            : h("span.chip.good", h("span.dot"), "Up to date");
    const av = st.available;
    const parts = [h("div.row.between", h("h3", "Updates"), chip),
      h("p.small.muted", `Tin Hat Server ${d.installed}` + (st.checked ? ` · checked ${ago(st.checked * 1000)}` : "") +
        (st.check_error ? ` · ${st.check_error}` : ""))];
    if (busy) {
      parts.push(h("p", st.phase === "downloading" ? "Downloading the update…" : UPDATE_STEPS[st.step] || "Updating…"),
        h("p.small.muted", "The server restarts its parts during the update, so chats and calls pause for a minute or two. " +
          "This page comes back by itself."));
    } else if (av && d.compose) {  // the Docker Compose edition: a new image does it (and checks + goes back by itself)
      parts.push(h("div.stack-sm",
        h("p", h("b", `Tin Hat Server ${av.version} is out.`), av.security ? " It includes security fixes." : ""),
        (av.notes || []).length ? h("ul.small", av.notes.map((n) => h("li", n))) : null,
        h("p.small", "Where this server's compose file is, run ", h("code", "docker compose pull && docker compose up -d"),
          ". It installs the new version, checks it, and goes back to this one by itself if it doesn't start properly.")));
    } else if (av) {
      const install = h("button.btn.cta.small", { type: "button" }, "Install now");
      install.addEventListener("click", async () => {
        install.disabled = true;
        install.replaceChildren(h("span.spin"), "Starting…");
        try {
          const r = await api("/admin/api/updates/install", { json: {} });
          following = r.installed;
          render(r);
        } catch (ex) { toast(ex.message); install.disabled = false; install.textContent = "Install now"; }
      });
      parts.push(h("div.stack-sm",
        h("p", h("b", `Tin Hat Server ${av.version} is ready.`), av.security ? " It includes security fixes." : ""),
        (av.notes || []).length ? h("ul.small", av.notes.map((n) => h("li", n))) : null,
        h("div.row.wrap", install, h("span.small.muted", d.settings.auto ? `Or tonight between ${d.window} (your time), when nobody's in a call.` : "Automatic updates are off."))));
    }
    if (st.message && !busy) parts.push(h(`div.note${st.phase === "broken" ? ".bad" : ""}`, st.message));
    const auto = h("input", { type: "checkbox" });
    auto.checked = !!d.settings.auto;
    auto.addEventListener("change", async () => {
      try { render(await api("/admin/api/updates/settings", { json: { auto: auto.checked } })); } catch (ex) { toast(ex.message); }
    });
    const check = h("button.btn.ghost.small", { type: "button" }, "Check now");
    check.addEventListener("click", async () => {
      check.disabled = true;
      check.replaceChildren(h("span.spin"), "Checking…");
      try { render(await api("/admin/api/updates/check", { json: {} })); } catch (ex) { toast(ex.message); check.disabled = false; check.textContent = "Check now"; }
    });
    parts.push(h("label.row.small", auto, h("span", `Install updates automatically at night (${d.window}, your time)`)),
      busy ? null : h("div.row.wrap", check));
    const hist = (d.history || []).slice().reverse().slice(0, 3);
    if (hist.length) {
      parts.push(h("div.list.small", hist.map((x) => h("div.item", h("div.grow",
        h("div.s", `${dateText(x.at * 1000)} · ` + (x.kind === "restart" ? "Restarted for a security update" : `${x.from} → ${x.to}: ${x.result}`)))))));
    }
    parts.push(h("p.small.muted", "Updates are signed by Tin Hat, and the server checks the signature before installing anything. " +
      "Before each update it makes a safety copy, and goes back to it by itself if the new version doesn't start properly. " +
      "Security fixes for the operating system install by themselves."));
    card.replaceChildren(...parts.filter(Boolean));
    if (busy) poll();
  };

  const poll = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!card.isConnected) return;
      try {
        render(await api("/admin/api/updates"));
      } catch (ex) {
        if (ex.status === 401) {  // signed out while the manager restarted: say so instead of spinning forever
          card.replaceChildren(h("h3", "Updates"), h("p", "The update restarted the server's dashboard. Sign in again to see how it went."),
            h("div.row", h("button.btn.cta.small", { type: "button", onclick: () => location.reload() }, "Sign in again")));
          return;
        }
        poll();  // the manager restarts mid-update: keep asking
      }
    }, 3000);
  };

  (async () => {
    try {
      const d = await api("/admin/api/updates");
      if (!d.settings.tz) {
        try {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          if (tz) await api("/admin/api/updates/settings", { json: { tz } });
        } catch { /* the window then uses UTC */ }
      }
      render(d);
    } catch (ex) {
      card.replaceChildren(h("h3", "Updates"), h("div.error", ex.message));
    }
  })();
  return card;
}

/** Backups: where they go, the password, the last one, test restore and a downloadable copy. */
function backupsCard() {
  const card = h("div.card.flat.stack-sm", h("h3", "Backups"), h("div.row", h("span.spin"), h("span.muted", "Loading…")));
  let timer = 0;
  let editing = false;
  const sizeText = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
  const countsText = (c) => (c && c.people !== undefined
    ? `${plural(c.people, "person", "people")}, ${plural(c.rooms, "room", "rooms")}, ${plural(c.messages, "message", "messages")}` : "");
  const load = async () => {
    try { render(await api("/admin/api/backups")); } catch (ex) { card.replaceChildren(h("h3", "Backups"), h("div.error", ex.message)); }
  };
  const poll = () => { clearTimeout(timer); timer = setTimeout(() => { if (card.isConnected) load(); }, 3000); };
  let wantDownload = false;  // the owner pressed Download: start it by itself when the copy is ready (round 7)
  const act = (label, path, json) => {
    const b = h("button.btn.ghost.small", { type: "button" }, label);
    b.addEventListener("click", async () => {
      b.disabled = true;
      if (path.endsWith("/download")) wantDownload = true;
      try { render(await api(path, { json: json || {} })); } catch (ex) { toast(ex.message); b.disabled = false; wantDownload = false; }
    });
    return b;
  };

  function form(d) {
    const err = h("div.error.hidden");
    let dest = d.settings.dest || (d.drives.length ? "usb" : "smb");
    let uuid = (d.settings.usb && d.settings.usb.uuid) || (d.drives[0] && d.drives[0].uuid);
    const opts = h("div.choices");
    const smb = { share: h("input", { type: "text", placeholder: "\\\\computer\\folder", value: (d.settings.smb && d.settings.smb.share) || "" }),
      user: h("input", { type: "text", autocomplete: "off", value: (d.settings.smb && d.settings.smb.user) || "" }),
      pw: h("input", { type: "password", autocomplete: "off" }) };
    const smbBox = h("div.stack-sm.hidden",
      h("label.field", h("span", "Shared folder"), smb.share, h("small", "On Windows: the folder's Properties → Sharing shows its network path.")),
      h("label.field", h("span", "User name on that computer"), smb.user), h("label.field", h("span", "Its password"), smb.pw));
    const draw = () => {
      const items = d.drives.map((x) => {
        const b = h("button.choice", { type: "button", "aria-checked": String(dest === "usb" && uuid === x.uuid) },
          h("div.t", `${x.label || x.model || "USB drive"} · ${sizeText(x.size)}`), h("div.d", `USB drive plugged into the server (${x.fstype})`));
        b.addEventListener("click", () => { dest = "usb"; uuid = x.uuid; draw(); });
        return b;
      });
      const s = h("button.choice", { type: "button", "aria-checked": String(dest === "smb") },
        h("div.t", "A shared folder on another computer or NAS"), h("div.d", "Windows file sharing (SMB). The other computer needs to be on when backups run."));
      s.addEventListener("click", () => { dest = "smb"; draw(); });
      opts.replaceChildren(...items, s);
      smbBox.classList.toggle("hidden", dest !== "smb");
    };
    draw();
    const p1 = h("input", { type: "password", autocomplete: "new-password" });
    const p2 = h("input", { type: "password", autocomplete: "new-password" });
    const save = h("button.btn.cta", { type: "button" }, "Save and back up now");
    save.addEventListener("click", async () => {
      err.classList.add("hidden");
      const body = dest === "usb" ? { dest, uuid } : { dest, share: smb.share.value, user: smb.user.value, smbPassword: smb.pw.value };
      if (!d.hasPassword) {
        if (p1.value.length < 10) { err.textContent = "Use a backup password of at least 10 characters."; err.classList.remove("hidden"); return; }
        if (p1.value !== p2.value) { err.textContent = "The two passwords don't match."; err.classList.remove("hidden"); return; }
        body.password = p1.value;
      }
      save.disabled = true;
      try {
        await api("/admin/api/backups/settings", { json: body });
        editing = false;
        render(await api("/admin/api/backups/run", { json: {} }));
        poll();
      } catch (ex) { err.textContent = ex.message; err.classList.remove("hidden"); save.disabled = false; }
    });
    return h("div.stack",
      h("p.small.muted", "A backup has everything needed to bring this server back on another computer: the database, the server's identity, its settings and the files people shared. It runs every night at 2:30 AM (your time)."),
      h("div.stack-sm", h("div.k", "Where should backups go?"), opts,
        d.drives.length ? null : h("p.small.muted", "No USB drive is plugged into the server. Plug one in (any size that fits your files; 32 GB or more is a good start) and ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); load(); } }, "look again"), "."),
        smbBox),
      d.hasPassword ? h("p.small.muted", "The backup password is already set.") : h("div.stack-sm",
        h("label.field", h("span", "Backup password"), p1), h("label.field", h("span", "The same password again"), p2),
        h("div.note", "Write it down and keep it with your Security Key. A backup can't be opened without it, by anyone: not you, not Tin Hat.")),
      err, h("div.row.end", d.settings.dest ? h("button.btn.ghost", { type: "button", onclick: () => { editing = false; load(); } }, "Cancel") : null, save));
  }

  function render(d) {
    clearTimeout(timer);
    const st = d.status || {};
    const set = d.settings || {};
    const ready = !!set.dest && d.hasPassword;
    const dl = st.download || {};
    const busy = d.busy || st.running || st.testing || dl.making;
    // The drive the backups go to isn't plugged into this computer (say, the server moved here from another one).
    const away = ready && set.dest === "usb" && !(d.drives || []).some((x) => set.usb && x.uuid === set.usb.uuid);
    const chip = !ready ? h("span.chip.warn", h("span.dot"), "Not set up")
      : busy ? h("span.chip.accent", h("span.spin"), st.running ? "Backing up" : st.testing ? "Testing" : "Working")
        : away ? h("span.chip.bad", h("span.dot"), "Drive not plugged in")
        : st.phase === "failed" ? h("span.chip.bad", h("span.dot"), "Last backup failed")
          : st.last ? h("span.chip.good", h("span.dot"), "Backed up") : h("span.chip.warn", h("span.dot"), "Not backed up yet");
    const parts = [h("div.row.between", h("h3", "Backups"), chip)];
    if (!ready || editing) {
      parts.push(form(d));
    } else {
      const where = set.dest === "usb" ? `USB drive: ${set.usb.label || set.usb.model || "drive"} (${sizeText(set.usb.size)})` : `Shared folder: ${set.smb.share}`;
      parts.push(h("p.small.muted", `${where}. Every night at ${d.nightAt} (your time); keeps 7 daily and 4 weekly copies.`));
      if (away) {
        parts.push(h("div.note.bad", `The USB drive “${set.usb.label || set.usb.model || "backup drive"}” isn't plugged into this server, so backups can't run. ` +
          "If the server moved here from another computer, the drive is probably still in that one: plug it in here, or choose Change to use another place."));
      }
      if (st.last) parts.push(h("p", `Last backup: ${dateTimeText(st.last.at * 1000)}` + (countsText(st.last.counts) ? ` · ${countsText(st.last.counts)}` : "") + (st.copies ? ` · ${plural(st.copies, "copy", "copies")} kept` : "")));
      if (st.phase === "failed" && st.message) parts.push(h("div.note.bad", `The last backup didn't work: ${st.message}`));
      if (st.test) {
        const t = st.test;
        parts.push(t.ok ? h("div.note", `Test restore ${dateTimeText(t.at * 1000)}: the backup works. It opened the newest copy with your backup password and brought back ${countsText(t.restored)}, with this server's identity.`)
          : h("div.note.bad", `Test restore ${dateTimeText(t.at * 1000)}: ${t.error || "the restored copy didn't match what the backup says it holds."}`));
      }
      if (dl.making) parts.push(h("p.small", h("span.spin"), " Making a copy to download… it starts downloading by itself when it's ready."));
      else if (dl.token) {
        const href = `/admin/api/backups/download/${dl.token}`;
        if (wantDownload) {  // one click: the copy downloads as soon as it's made
          wantDownload = false;
          setTimeout(() => { location.href = href; }, 300);
        }
        parts.push(h("div.stack-sm", h("p", `${dl.name} (${sizeText(dl.size)})` + (countsText(dl.counts) ? `: ${countsText(dl.counts)}` : "") + ". If it didn't download by itself: ",
          h("a", { href }, "download it")),
        h("p.small.muted", "It's locked with your backup password. Keep it somewhere other than this server: a USB stick, another computer, cloud storage.")));
      }
      else if (dl.error) parts.push(h("div.note.bad", dl.error));
      if (!busy) {
        const tpw = h("input", { type: "password", autocomplete: "off", "aria-label": "Backup password" });
        const tgo = h("button.btn.ghost.small", { type: "submit" }, "Test with this password");
        const tform = h("form.row.wrap.hidden", {
          onsubmit: async (e) => {
            e.preventDefault();
            if (!tpw.value) { toast("Type your backup password first."); tpw.focus(); return; }
            tgo.disabled = true;
            try { render(await api("/admin/api/backups/test", { json: { password: tpw.value } })); } catch (ex) { toast(ex.message); tgo.disabled = false; tpw.select(); }
          },
        }, h("label.field.inline", h("span", "Your backup password"), tpw), tgo);
        const test = h("button.btn.ghost.small", { type: "button", onclick: () => { tform.classList.remove("hidden"); test.remove(); tpw.focus(); } }, "Test restore");
        parts.push(h("p.small.muted", "Test restore asks for your backup password (the one thing a restore on another computer needs), then opens the newest copy and checks what's in it, without touching this server."));
        parts.push(h("div.row.wrap", act("Back up now", "/admin/api/backups/run"), test,
          act("Download a copy", "/admin/api/backups/download", { media: true }),
          h("button.btn.ghost.small", { type: "button", onclick: () => { editing = true; render(d); } }, "Change")), tform);
      }
      const fresh = act("Make a fresh copy to move with", "/admin/api/backups/download", { media: true });
      parts.push(h("details.stack-sm", h("summary.small", "Moving to another computer?"),
        h("ol.small",
          h("li", "Right before you move, make a fresh copy, so nothing written since the last backup gets left behind: ", busy ? null : fresh, " (or Back up now, if you'll move the USB drive)."),
          h("li", "On the new computer's setup page, choose Restore from a backup: the downloaded copy, or the USB drive plugged into it."),
          h("li", "Switch this computer off when the new one says so. Friends sign in as before, with their own passwords. Your admin password is the one this server has when you make the copy."))));
    }
    card.replaceChildren(...parts);
    if (busy) poll();
  }
  load();
  return card;
}

const MOVE_STEP_INFO = {
  check: "Checking the new address and the chat database…",
  certificate: "Getting a certificate for the new address through your DNS provider, or checking that your reverse proxy sends it here (up to a few minutes). Nothing has changed yet.",
  stop: "Pausing chat…",
  export: "Saving a copy of the chat database and the settings: the way back if anything goes wrong…",
  rebuild: "Moving every account, room and message to the new name. With a long history this takes a while.",
  switch: "Switching the server's settings to the new address…",
  chat: "Starting chat under the new name…",
  secure: "Opening the new address…",
  tell: "Pointing the old address to the new one…",
  outside: "Checking from outside your home…",
};

/** Move to your own domain (move.py): the same server, people, rooms and messages, at a domain the owner owns. */
function moveCard() {
  const title = "Move to your own domain";
  const card = h("div.card.flat.stack-sm", h("h3", title), h("div.row", h("span.spin"), h("span.muted", "Loading…")));
  let timer = 0;
  let open = false;    // the form is showing
  let sent = null;     // what the last check was for (the API token stays in this page, never in the browser's storage)
  let checked = null;  // the check's answer, which the owner confirms
  let following = false;  // a move is under way: the web server restarts during it, so a failed request means ask again
  let letGo = null;       // the old address the owner is about to let go of (its confirmation is showing)
  const load = async () => {
    try {
      render(await api("/admin/api/move"));
    } catch (ex) {
      if (following && ex.status === 401) {
        card.replaceChildren(h("h3", title), h("p", "The dashboard signed you out during the move. Sign in again to see how it went (at the new address once it's done)."),
          h("div.row", h("button.btn.cta.small", { type: "button", onclick: () => location.reload() }, "Sign in again")));
        return;
      }
      if (following) { poll(); return; }
      card.replaceChildren(h("h3", title), h("div.error", ex.message));
    }
  };
  const poll = () => { clearTimeout(timer); timer = setTimeout(() => { if (card.isConnected) load(); }, 2500); };
  const icon = (st) => (st === "running" ? h("span.spin")
    : h(`span.ico.${{ done: "done", failed: "failed", warn: "warn" }[st] || "pending"}`, { html: { done: ICON.check, failed: ICON.cross, warn: ICON.dash }[st] || "" }));
  const stepList = (p) => h("div.list.progress", p.steps.map((s) => h("div.item", icon(s.status),
    h("div.grow", h("div.k", s.label),
      s.status === "running" ? h("div.s", s.detail || MOVE_STEP_INFO[s.id] || "") : null,
      s.detail && !["running", "pending"].includes(s.status) ? h(`div.s${["warn", "failed"].includes(s.status) ? ".warn-text" : ""}`, s.detail) : null))));

  function form(d) {
    const err = h("div.error.hidden");
    const fail = (m) => { err.textContent = m; err.classList.remove("hidden"); };
    const domIn = h("input", { type: "text", placeholder: "chat.example.com", autocomplete: "off", autocapitalize: "none", spellcheck: "false", value: sent ? sent.name : "" });
    // A machine shared with another web server stays behind that one: only "My own reverse proxy" there.
    const provs = Object.entries(OWN_PROVIDERS).filter(([k]) => !d.proxy_only || k === "proxy");
    const provSel = h("select", { "aria-label": "DNS provider" }, provs.map(([k, v]) => h("option", { value: k, selected: sent && sent.domain.provider === k ? "" : null }, v.label)));
    const credBox = h("div.stack-sm");
    const credIn = {};
    const drawCreds = () => {
      const pv = OWN_PROVIDERS[provSel.value];
      credBox.replaceChildren(...pv.fields.map(([k, label]) => {
        credIn[k] = credIn[k] || h("input", { type: "password", autocomplete: "off", spellcheck: "false", value: (sent && sent.domain[k]) || "" });
        return h("label.field", h("span", `${pv.label} ${label}`), credIn[k]);
      }), h("small", provSel.value === "proxy"
        ? "Your nginx, Traefik, Caddy or Nginx Proxy Manager has port 443 and gets the certificate; this server listens on port 8080 for it. After Check you get the settings to paste into your proxy, and the move checks that it sends the new address here before anything changes."
        : pv.help));
    };
    provSel.addEventListener("change", drawCreds);
    drawCreds();
    const go = h("button.btn.cta", { type: "submit" }, "Check");
    const answers = () => {
      const name = domIn.value.trim().toLowerCase().replace(/\.$/, "");
      if (!name.includes(".")) throw new Error("Type the full address for your server, like chat.example.com.");
      const pv = OWN_PROVIDERS[provSel.value];
      const domain = { provider: provSel.value };
      for (const [k, label] of pv.fields) {
        domain[k] = (credIn[k].value || "").trim();
        if (!domain[k]) throw new Error(`Paste your ${pv.label} ${label}.`);
      }
      return { name, domain };
    };
    return h("form.stack", {
      onsubmit: async (e) => {
        e.preventDefault();
        err.classList.add("hidden");
        let a;
        try { a = answers(); } catch (ex) { fail(ex.message); return; }
        go.disabled = true;
        go.replaceChildren(h("span.spin"), "Checking…");
        try {
          const r = await api("/admin/api/move/check", { json: a });
          if (!r.ok) { fail(r.problem || "That didn't check out."); go.disabled = false; go.textContent = "Check"; return; }
          sent = a;
          checked = r;
          render(d);
        } catch (ex) { fail(ex.message); go.disabled = false; go.textContent = "Check"; }
      },
    },
    h("label.field", h("span", "The new address"), domIn, h("small", `A name in a domain you own, like chat.example.com. People's addresses become @alex:chat.example.com instead of @alex:${d.server_name}.`)),
    h("label.field", h("span", "Where the domain's DNS is, or who handles HTTPS"), provSel),
    credBox, err,
    h("div.row.end", h("button.btn.ghost", { type: "button", onclick: () => { open = false; checked = null; render(d); } }, "Cancel"), go));
  }

  function confirmBox(d) {
    const r = checked;
    const err = h("div.error.hidden");
    const typed = h("input", { type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-label": `Type ${r.to} to confirm` });
    const go = h("button.btn.cta", { type: "submit" }, `Move to ${r.to}`);
    return h("form.stack", {
      onsubmit: async (e) => {
        e.preventDefault();
        err.classList.add("hidden");
        if (typed.value.trim().toLowerCase().replace(/\.$/, "") !== r.to) { err.textContent = `Type ${r.to} to confirm.`; err.classList.remove("hidden"); typed.focus(); return; }
        go.disabled = true;
        go.replaceChildren(h("span.spin"), "Starting…");
        try {
          const doc = await api("/admin/api/move/start", { json: { ...sent, confirm: r.to } });
          open = false; checked = null; sent = null;  // the token leaves this page's memory too
          following = true;
          render(doc);
        } catch (ex) { err.textContent = ex.message; err.classList.remove("hidden"); go.disabled = false; go.textContent = `Move to ${r.to}`; }
      },
    },
    h("p", h("b", `${r.from} → ${r.to}`), ` · ${plural(r.people, "person", "people")}, ${plural(r.rooms, "room", "rooms")}, ${plural(r.events, "message or event", "messages and events")}`),
    (r.warnings || []).map((w) => h("div.note", w)),
    r.proxy ? proxyCard(r.proxy) : null,
    h("ul.small",
      h("li", "Chat pauses while the server moves: a few minutes, longer with a long history. A copy of everything is made first; if something goes wrong before people can use the new address, the server goes back to how it was, under its old name. After that, this card says what to fix."),
      h("li", `Everyone is signed out. They sign in at ${r.to} with the same username and password, then unlock with their Security Key, and their messages are back. Without the Security Key, older encrypted messages can't be read (new ones work).`),
      h("li", "The move gives everyone a new encryption identity under the same Security Key, so friends who had verified each other do it once more."),
      h("li", r.provider === "proxy"
        ? `Apps that still use ${r.from} reach this server only while something sends ${r.from} here; everyone is told to sign in at ${r.to}.`
        : `${r.from} keeps answering for a while: apps that still use it reach this server and are told the new address.`)),
    h("label.field", h("span", `Type ${r.to} to confirm`), typed), err,
    h("div.row.end", h("button.btn.ghost", { type: "button", onclick: () => { checked = null; render(d); } }, "Back"), go));
  }

  /** Let go of an old address: the server stops answering it (a tinhat.me name goes back to the names service for good). */
  function letGoBox(d, f) {
    const err = h("div.error.hidden");
    const typed = h("input", { type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-label": `Type ${f.name} to confirm` });
    const go = h("button.btn.danger", { type: "submit" }, `Let go of ${f.name}`);
    const tinhat = f.mode === "anywhere";
    return h("form.card.flat.stack-sm", {
      onsubmit: async (e) => {
        e.preventDefault();
        err.classList.add("hidden");
        if (typed.value.trim().toLowerCase() !== f.name) { err.textContent = `Type ${f.name} to confirm.`; err.classList.remove("hidden"); typed.focus(); return; }
        go.disabled = true;
        go.replaceChildren(h("span.spin"), "Letting go…");
        try {
          const doc = await api("/admin/api/move/let-go", { json: { name: f.name, confirm: f.name } });
          letGo = null;
          if (doc.message) toast(doc.message);
          render(doc);
        } catch (ex) { err.textContent = ex.message; err.classList.remove("hidden"); go.disabled = false; go.textContent = `Let go of ${f.name}`; }
      },
    },
    h("div.k", `Let go of ${f.name}?`),
    h("ul.small",
      h("li", `This server stops answering ${f.name}: apps and links that still use it stop working here. Everyone signs in at ${d.server_name}.`),
      h("li", "Pictures and files from before the move keep opening."),
      tinhat ? h("li", h("b", `${f.name} goes back to the Tin Hat names service for good: nobody can use it again, you included.`)) : null),
    h("label.field", h("span", `Type ${f.name} to confirm`), typed), err,
    h("div.row.end", h("button.btn.ghost", { type: "button", onclick: () => { letGo = null; render(d); } }, "Cancel"), go));
  }

  function friendsNote(to) {
    const text = `Our Tin Hat server moved to ${to}. Open Tin Hat and sign in at ${to} with the same username and password, then unlock with your Security Key: your messages come back.`;
    return h("div.stack-sm", h("div.k", "Tell your friends"), h("p.small", text),
      h("div.row.wrap", h("button.btn.ghost.small", { type: "button", onclick: () => copy(text, "Message") }, "Copy the message")));
  }

  function render(d) {
    clearTimeout(timer);
    const p = d.progress || {};
    const running = !!p.running || p.status === "running" || p.status === "rolling-back";
    following = running;
    const chip = p.status === "rolling-back" ? h("span.chip.warn", h("span.spin"), "Putting back")
      : running ? h("span.chip.accent", h("span.spin"), "Moving")
      : p.status === "done" ? h("span.chip.good", h("span.dot"), "Moved")
        : p.status === "failed" ? h("span.chip.bad", h("span.dot"), "Didn't move") : null;
    const parts = [h("div.row.between", h("h3", title), chip)];
    if (p.status === "rolling-back") {
      parts.push(h("div.note.bad", p.error || "The move didn't work."),
        h("p", `Putting the server back as ${p.from}. Chat stays off until that's done; if it doesn't finish, the server tries again at every start.`),
        h("details.stack-sm", h("summary.small", "Details"), stepList(p), p.details ? h("pre.small.report", p.details) : null));
    } else if (running) {
      parts.push(h("p", `Moving ${p.from} to ${p.to}. Chat pauses for part of it; this page keeps working here.`), stepList(p));
    } else if (open && checked) {
      parts.push(confirmBox(d));
    } else if (open) {
      parts.push(form(d));
    } else {
      if (p.status === "done") {
        parts.push(h("p", `This server moved from ${p.from} to ${p.to}` + (p.finished ? ` (${dateText(p.finished * 1000)}).` : ".")),
          h("div.row.wrap", h("a.btn.cta.small", { href: `https://${p.to}/admin` }, `Open the dashboard at ${p.to}`)),
          friendsNote(p.to), h("details.stack-sm", h("summary.small", "How the move went"), stepList(p)));
      } else if (p.status === "failed") {
        parts.push(h("div.note.bad", p.error || "The move didn't work."),
          h("p.small.muted", (p.details || "").includes("Nothing changed") ? `Nothing changed: the server is still ${d.server_name}.` : "See the details below."),
          h("details.stack-sm", h("summary.small", "Details"), stepList(p), p.details ? h("pre.small.report", p.details) : null));
      }
      if (d.relay) {
        parts.push(h("p.small.muted", "Your server can move to a domain you own, with everyone's accounts, rooms and messages."),
          h("div.note", "This server is reached through the Tin Hat relay, which carries tinhat.me names only. Your own domain needs your router to let friends reach this server directly (ports 443, 7881 and 7882), or your own reverse proxy in front of it. The Network tab shows what your router allows."));
      } else {
        const start = h("button.btn.ghost.small", { type: "button", onclick: () => { open = true; render(d); } },
          p.status === "done" || d.mode === "domain" ? "Move to another domain…" : "Move to your own domain…");
        parts.push(h("p.small.muted", d.mode === "domain"
          ? "Move this server to another domain you own, with everyone's accounts, rooms and messages."
          : `Move this server from ${d.server_name} to a domain you own (like chat.example.com), with everyone's accounts, rooms and messages. ` +
            (d.mode === "anywhere" ? "Nothing then depends on tinhat.me." : "Friends can then reach it from anywhere.")),
        h("div.row.wrap", start));
      }
      const held = (d.former || []).filter((f) => !f.released);
      if (held.length) {
        const olds = held.map((f) => f.name + (f.at ? ` (moved ${dateText(f.at * 1000)})` : "")).join(", ");
        parts.push(h("p.small.muted", d.behind_proxy
          ? `Old addresses: ${olds}. Behind your reverse proxy they lead here only if the proxy sends them here; pictures and files from before the move still open.`
          : `Old addresses that still answer here: ${olds}. Apps that still use them reach this server and are told the new address.`));
      }
      const open = (d.former || []).filter((f) => !f.released || f.pending);  // held, or a let-go that didn't finish
      if (open.length) {
        parts.push(h("div.row.wrap", open.map((f) => h("button.btn.ghost.small", { type: "button", onclick: () => { letGo = f; render(d); } },
          f.pending ? `Finish letting go of ${f.name}…` : `Let go of ${f.name}…`))));
      }
      if (letGo) parts.push(letGoBox(d, letGo));
    }
    card.replaceChildren(...parts.flat().filter(Boolean));
    if (running) poll();
  }
  load();
  return card;
}

/** Command-line access (SSH): off by default; the owner's own key; home network only. */
function sshCard() {
  const card = h("div.card.flat.stack-sm", h("h3", "Command-line access (SSH)"), h("div.row", h("span.spin"), h("span.muted", "Loading…")));
  const err = h("div.error.hidden");
  const fail = (m) => { err.textContent = m; err.classList.remove("hidden"); };
  const send = async (json, btn) => {
    err.classList.add("hidden");
    if (btn) btn.disabled = true;
    try { render(await api("/admin/api/ssh", { json })); } catch (ex) { fail(ex.message); if (btn) btn.disabled = false; }
  };
  const render = (d) => {
    if (d.available === false) {  // installed on the owner's own Linux machine: its SSH is theirs
      card.replaceChildren(h("h3", "Command-line access (SSH)"),
        h("p.small.muted", "This server runs on your own Linux machine, so SSH is yours to set up as you like. On the machine, ", h("code", "sudo tinhat"), " shows the server's status, logs, setup and recovery codes."));
      return;
    }
    const key = h("textarea", { rows: "3", placeholder: "ssh-ed25519 AAAA… you@your-computer", spellcheck: "false" });
    const parts = [h("div.row.between", h("h3", "Command-line access (SSH)"),
      d.on ? h("span.chip.warn", h("span.dot"), "On") : h("span.chip", "Off"))];
    if (!d.on) {
      const on = h("button.btn.ghost.small", { type: "button" }, "Turn on");
      on.addEventListener("click", () => send({ action: "on", key: key.value }, on));
      parts.push(h("p.small.muted", "For people who know their way around a Linux terminal. Not needed for anything in Tin Hat: everything is here in the dashboard."),
        h("label.field", h("span", "Your SSH public key (the .pub file)"), key),
        h("p.small.muted", "SSH then answers only from your home network, as the user tinhat, with sudo. Changes made by hand can be undone by updates."),
        err, h("div.row", on));
    } else {
      const add = h("button.btn.ghost.small", { type: "button" }, "Add this key");
      add.addEventListener("click", () => send({ action: "add-key", key: key.value }, add));
      const off = h("button.btn.ghost.small", { type: "button" }, "Turn off");
      off.addEventListener("click", () => {
        if (off.dataset.sure !== "1") { off.dataset.sure = "1"; off.textContent = "Turn off — sure?"; return; }
        send({ action: "off" }, off);
      });
      parts.push(h("p.small", "Connect with: ", ...d.commands.map((c, i) => [i ? " or " : "", h("code", c)]).flat()),
        h("div.small.muted", "Check the server's fingerprint the first time you connect:", h("ul.small", d.hostKeys.map((f) => h("li.mono", f)))),
        h("div.list", d.keys.map((k) => h("div.item", h("div.grow", h("div.k", k.comment || k.type), h("div.s.mono", k.fingerprint)),
          h("button.btn.ghost.small", { type: "button", onclick: (e) => send({ action: "remove-key", fingerprint: k.fingerprint }, e.currentTarget) }, "Remove")))),
        h("label.field", h("span", "Add another public key"), key), err, h("div.row.wrap", add, off),
        h("p.small.muted", "Only from your home network; never opened on your router. Changes made by hand can be undone by updates."));
    }
    card.replaceChildren(...parts);
  };
  api("/admin/api/ssh").then(render).catch((ex) => card.replaceChildren(h("h3", "Command-line access (SSH)"), h("div.error", ex.message)));
  return card;
}

/** Get help: a support report to copy (nothing secret in it), shown before it's copied. */
function helpCard() {
  const show = h("button.btn.ghost.small", { type: "button" }, "Show the support report");
  const copyBtn = h("button.btn.ghost.small", { type: "button" }, "Copy it");
  const box = h("pre.small.hidden.report");
  const get = async () => {
    const r = await fetch("/admin/api/support-report", { credentials: "same-origin", headers: { "X-Tinhat": "1" } });
    if (!r.ok) throw new Error(`Couldn't make the report (error ${r.status}).`);
    return r.text();
  };
  show.addEventListener("click", async () => {
    try { box.textContent = await get(); box.classList.remove("hidden"); } catch (ex) { toast(ex.message); }
  });
  copyBtn.addEventListener("click", async () => {
    try { const t = box.textContent || await get(); box.textContent = t; box.classList.remove("hidden"); await copy(t, "Support report"); } catch (ex) { toast(ex.message); }
  });
  return h("div.card.flat.stack-sm", h("h3", "Get help"),
    h("p.small.muted", "If something isn't working, send this report to whoever helps you with the server. It has the versions, what's running, the network check and recent errors. It never has passwords, keys, codes, people's names or messages; read it first if you like."),
    h("div.row.wrap", show, copyBtn), box);
}
