// setup.js — the setup wizard: code → Check → Features → Name → Account → Install → done.
// Every screen has a "What's happening?" panel (open/closed, remembered) that says what the step does, why, and
// what happens on the server.
"use strict";

const app = $("#app");
const answers = {
  mode: "lan",
  name: "",
  code: "", // a server code (TN-XXXX-XXXX) for a from-anywhere name, while names are invite-only
  admin: { displayName: "", username: "", password: "" },
  features: null, // {calls, previews, directory, uploadMb}, filled from the recommendations
  dashboardAccess: "anywhere", // asked on the Account page when this browser isn't on the server's home network
};
let status = null;
let assessment = null; // {probe, bench, net, advice}
let addresses = [];
let zone = "tinhat.me"; // from-anywhere names live under it (the server says which)
const serverName = () => (answers.mode === "anywhere" ? `${answers.name}.${zone}` : answers.mode === "domain" ? answers.name : `${answers.name}.local`);

const FLOW = [
  ["check", "Check"],
  ["features", "Features"],
  ["name", "Name"],
  ["account", "Account"],
  ["install", "Install"],
];

// ---- the "What's happening?" texts ------------------------------------------------------------------------------

const INFO = {
  start: {
    title: "New, or from a backup?",
    body: [
      "A new server starts empty: you choose its name and make the first account.",
      "Restoring brings back a server you backed up before, on this computer: same name, same people, rooms and messages. People sign in as before.",
    ],
    tech: [
      "Backups are made from the dashboard (Maintenance → Backups) to a USB drive, a shared folder, or a downloaded file.",
    ],
  },
  restore: {
    title: "What restoring does",
    body: [
      "Your backup is encrypted with its backup password, so the password is needed to open it here.",
      "The server comes back exactly as it was when the copy was made. If it was reachable from anywhere, its name moves to this computer; the old computer can't use it any more, so switch that one off.",
    ],
    tech: [
      "Backups are restic repositories: a database dump, the server's settings and signing key (its identity), and the files people shared.",
      "The names service gives this computer a new key for the name and stops accepting the old one.",
    ],
  },
  unlockOwn: {
    title: "Why a setup code?",
    body: [
      "Anyone who can open this page could set the server up. The code proves you're the person who installed it, so nobody else can set it up before you.",
      "The installer printed it at the end. On the server, sudo tinhat setup-code shows it again.",
    ],
    tech: [
      "The code is 8 random digits, made when the server first started and deleted when setup finishes.",
      "Ten wrong tries in a row lock this page for ten minutes.",
    ],
  },
  unlockWin: {
    title: "Why a setup code?",
    body: [
      "Anyone on your network could open this page. The code proves you're the person at the PC the server runs on, so nobody else can set it up before you.",
      "The installer's last page showed it. The Tin Hat Server icon next to the clock shows it again: right-click it and choose Show setup code.",
    ],
    tech: [
      "The code is 8 random digits, made when the server first started and deleted when setup finishes.",
      "Ten wrong tries in a row lock this page for ten minutes.",
    ],
  },
  unlock: {
    title: "Why a setup code?",
    body: [
      "Anyone on your network could open this page. The code proves you're the person who can see the server's own screen, so nobody else can set it up before you.",
      "Find it on the server's screen: the virtual machine's console window (in Proxmox, the VM's Console tab; in VirtualBox, the VM's window), or a monitor plugged into the machine.",
    ],
    tech: [
      "The code is 8 random digits, made on first boot and deleted when setup finishes.",
      "Ten wrong tries in a row lock this page for ten minutes.",
    ],
  },
  check: {
    title: "What the check does",
    body: [
      "Your server measures itself for a few seconds, and this device measures the network between you and the server. The results decide which features we recommend on the next step.",
      "Nothing leaves your network: the tests only talk to your server.",
    ],
    tech: [
      "Processor: compresses chat-like data for a second, on one core and then on all of them.",
      "Storage: writes 128 MB, then saves 4 KB forty times, the way the database saves each message.",
      "Network: this browser downloads and uploads a few megabytes to and from the server and times it.",
      "Internet: checks whether the server can reach the outside world.",
    ],
  },
  features: {
    title: "Choosing what to run",
    body: [
      "Green: this server handles it well. Yellow: it works, with the limit the reason names. Red: not recommended on this machine. Grey: not available yet, or needs the internet.",
      "The recommended settings are already picked. Change anything you like, now or later in the server's dashboard.",
    ],
    tech: [
      "Calls: starts the call service (LiveKit) and the small service that signs people into calls. Off means neither runs.",
      "Link previews: the chat server fetches the page itself, and never from private addresses on your network.",
      "Biggest file: the chat server's upload limit.",
      "Find people by name: the chat server's people search covers everyone on this server.",
    ],
  },
  name: {
    title: "Your server's name",
    body: [
      "Home network: devices on your network find the server as name.local. Nothing is opened to the internet, and each device trusts the server's own certificate once.",
      "Friends anywhere: the server gets name.tinhat.me with a real certificate, so no device needs a trust step. It opens three ports on your router and checks from outside. While names are new, you need a server code from Tin Hat.",
      "My own domain (advanced): the server lives at a domain you own, like chat.example.com, and nothing depends on tinhat.me. You paste an API token from your DNS provider so the server can get its certificate, or send the domain to it from your own reverse proxy.",
      "The name can't change later: it's part of every account, like @alex:crew.tinhat.me. Friends only ever type the first part (crew), or the whole domain for your own.",
    ],
    tech: [
      "Home network: mDNS announces name.local, the way printers show up; the server is its own certificate authority.",
      "Friends anywhere: the Tin Hat names service points name.tinhat.me at your server's public address and keeps it current. Let's Encrypt issues the certificate through a DNS check that only your server can pass, so no port needs to be open for it.",
      "Ports: TCP 443 (the app and chat), TCP 7881 and UDP 7882 (calls). The server asks your router to open them (UPnP or NAT-PMP).",
      "Own domain behind your own reverse proxy: your proxy keeps port 443 and its certificate and sends the domain to this server's port 8080 (home-network addresses only); the server opens only the call ports on your router.",
      "Own domain: the certificate comes from Let's Encrypt by a DNS check through your provider's API (Cloudflare, Porkbun, deSEC or DuckDNS). With Cloudflare the server also keeps the domain's address record pointing at this server; with the others that stays your job (at home, your router's dynamic DNS can do it). The token is kept on your server only, and goes in its backups.",
      "Behind carrier NAT (5G home internet, Starlink), no port can be opened. Setup then offers the Tin Hat relay: your server keeps a connection open to it and friends reach the server through it. The certificate and its key stay on your server, so the relay can't read what passes through.",
    ],
  },
  account: {
    title: "Your admin account",
    body: [
      "This is your everyday Tin Hat account, plus the power to manage the server: invite people, see who's on it, restart its parts.",
      "Write the password down somewhere safe. A home server can't email you a reset link.",
    ],
    tech: [
      "The password is stored only on your server, hashed with bcrypt.",
      "The account is a server admin; the dashboard checks that when you sign in.",
    ],
  },
  review: {
    title: "What installing does",
    body: [
      "Installing takes about a minute for a home server, and usually 1–3 minutes for friends anywhere (it also gets a certificate, opens ports on your router and checks from outside). The server starts its parts one at a time and checks each one works before moving on.",
      "If something fails, it says what went wrong and offers Try again, which picks up where it stopped.",
    ],
    tech: [], // filled with the install steps below
  },
  done: {
    title: "Why trust a certificate?",
    body: [
      "Your devices only send passwords and messages to a server they can verify. A home server has no public certificate, so it makes its own, and you tell each device to trust it, once.",
      "After that the padlock shows in the address bar, and Tin Hat works like any website.",
    ],
    tech: [
      "The certificate authority is created on your server and its private key never leaves it.",
      "It lasts ten years. The server renews its own site certificate every few hours by itself.",
    ],
  },
};

INFO.doneDomain = {
  title: "Why there's no certificate step",
  body: [
    "Your server has a real certificate from Let's Encrypt for your own domain, so every phone and computer trusts it already.",
    "The outside check is the same thing a friend's device does: it connects to your server's public address on each port.",
  ],
  tech: [
    "The certificate renews by itself every couple of months, by the same DNS check through your provider's API.",
    "With Cloudflare, the server keeps the domain's address record pointing at this server (checked every ten minutes). With the other providers, keep it current yourself, for example with your router's dynamic DNS.",
    "Nothing here depends on tinhat.me. The outside check still asks the Tin Hat names service to connect back, because something outside has to.",
  ],
};

INFO.doneProxy = {
  title: "What your proxy does",
  body: [
    "Your reverse proxy keeps port 443 and the certificate for your domain, and passes everything on to this server's port 8080 on your home network.",
    "Calls don't go through it: this server asks your router for TCP 7881 and UDP 7882 itself, the same as without a proxy.",
  ],
  tech: [
    "Port 8080 only answers home-network addresses. It takes the visitor's address from your proxy's X-Forwarded-For header.",
    "This server's own services reach it over its own certificate on its own loopback address, never through your proxy.",
    "The outside check connects to your server's public address on each port the way a friend's device would, with your domain's name, so it goes through your proxy too.",
  ],
};

INFO.doneAnywhere = {
  title: "Why there's no certificate step",
  body: [
    "From anywhere, your server has a real certificate from Let's Encrypt, the same kind websites use, so every phone and computer trusts it already.",
    "The outside check is the same thing a friend's device does: it connects to your server's public address on each port.",
  ],
  tech: [
    "The certificate renews by itself every couple of months, through the Tin Hat names service's DNS check.",
    "Your server keeps its name pointed at its public address: if that address changes (a home's internet provider does that now and then), it updates within ten minutes.",
  ],
};

INFO.doneRelay = {
  title: "How friends reach your server",
  body: [
    "Your server keeps a connection open to the Tin Hat relay, and friends outside reach it through the relay, so nothing has to be opened on your router.",
    "Your server has a real certificate from Let's Encrypt and keeps its key, so the relay passes everything on without being able to read it: messages, calls and passwords stay between your friends' devices and your server.",
  ],
  tech: [
    "The connection is a WireGuard tunnel your server opens itself; it survives your provider's carrier NAT because the server keeps it busy every 25 seconds.",
    "The relay forwards HTTPS by your server's name, and one port of its own (TCP and UDP) for calls. People at home still connect straight to the server for calls.",
    "The relay sees who connects and how much (not what): that's what it needs to pass traffic on. Each server has a monthly allowance; the dashboard's Network tab shows how much is used.",
  ],
};

const STEP_INFO = {
  dns: "Checks your domain with your DNS provider. With Cloudflare, the server points it at its own public address itself; with the others, it checks the address is already right and tells you if not.",
  name: "Reserves your name with the Tin Hat names service (a few seconds of number crunching proves this is a real new server), and points it at your server's public address.",
  ports: "Asks your router to open TCP 443, TCP 7881 and UDP 7882 for this server (UPnP or NAT-PMP), and notices if your internet provider or a second router is in the way. Behind carrier NAT it offers the Tin Hat relay instead.",
  outside: "The names service connects back from outside on each port, the way a friend's device would. Calls pause for a few seconds during the check.",
  prepare: "Writes the settings for every part, and makes the server's own secrets: its database password, call keys and the chat server's signing key.",
  database: "Starts PostgreSQL, the database that keeps every account, room and message.",
  chat: "Starts Synapse, the chat server. Its first start builds the database tables, which is the longest step.",
  accounts: "Creates your admin account, a hidden system account the dashboard uses, and the General room new people join.",
  secure: "Turns on HTTPS. Home network: the server becomes its own certificate authority and signs a certificate for its name. Friends anywhere: Let's Encrypt issues a real certificate. Either way it then tests a real secure connection end to end.",
  calls: "Starts the call service (LiveKit) and the small service that signs people into calls, then checks both answer.",
  finish: "Saves the setup, deletes the setup code and renames the server to its new name.",
  restore: "Reads the backup with your backup password and puts the server's settings, identity and people's files back.",
  restoredb: "Starts the database and loads every account, room and message from the backup into it.",
  takeover: "Tells the Tin Hat names service that the server lives on this computer now. The old computer's key to the name stops working, so the two can't fight over it.",
};
const STEP_LABELS = {
  name: "Reserving your server's name", ports: "Opening ports on your router", outside: "Checking from outside",
  prepare: "Preparing your server", database: "Starting the database", chat: "Starting the chat server",
  accounts: "Creating your admin account", secure: "Securing connections (HTTPS)", calls: "Starting voice and video calls",
  finish: "Finishing up", dns: "Pointing your domain at your server",
};
// Only the steps a new server runs (the restore steps have their own screen).
INFO.review.tech = Object.keys(STEP_LABELS).map((k) => `${STEP_LABELS[k]}: ${STEP_INFO[k]}`);

// ---- frame: stepper + card + info panel -------------------------------------------------------------------------

function infoOpenPref() {
  try {
    const v = localStorage.getItem("tinhat.setup.info");
    if (v === "1" || v === "0") return v === "1";
  } catch {
    /* storage blocked */
  }
  return window.matchMedia("(min-width: 1080px)").matches;
}

function infoPanel(info, extra) {
  const close = h("button.icon-btn", { type: "button", "aria-label": "Close the explanation" }, "×");
  const panel = h("aside.info", { id: "info", "aria-label": "What's happening" },
    h("div.row.between", h("div.eyebrow", "What's happening"), close),
    h("h3", info.title),
    ...info.body.map((t) => h("p", t)),
    extra || null,
    info.tech && info.tech.length
      ? h("details.tech-list", h("summary", "On the server"), h("ul", info.tech.map((t) => h("li", t))))
      : null);
  return { panel, close };
}

function frame(stepId, info, card, extraInfo) {
  const open = infoOpenPref();
  const wiz = h(`div.wizard${open ? ".info-open" : ""}`);
  const { panel, close } = infoPanel(info, extraInfo);
  const toggle = h("button.info-toggle", { type: "button", "aria-controls": "info", "aria-expanded": String(open) },
    h("span.i", "i"), "What's happening?");
  const setOpen = (v) => {
    wiz.classList.toggle("info-open", v);
    toggle.setAttribute("aria-expanded", String(v));
    try {
      localStorage.setItem("tinhat.setup.info", v ? "1" : "0");
    } catch {
      /* storage blocked */
    }
  };
  toggle.addEventListener("click", () => setOpen(!wiz.classList.contains("info-open")));
  close.addEventListener("click", () => setOpen(false));
  const i = FLOW.findIndex(([id]) => id === stepId);
  const head = h("div.wiz-head",
    i >= 0
      ? h("div.grow",
          h("ol.stepper", { "aria-label": "Setup steps" }, FLOW.map(([id, label], n) =>
            h(`li${n < i ? ".done" : n === i ? ".on" : ""}`, n === i ? { "aria-current": "step" } : null,
              h("span.num", n < i ? "✓" : String(n + 1)), h("span.lbl", label)))),
          h("div.stepline", `Step ${i + 1} of ${FLOW.length} · ${FLOW[i][1]}`))
      : h("div.grow"),
    toggle);
  card.classList.add("wiz-card");
  wiz.append(head, panel, card);
  return wiz;
}

function show(stepId, info, card, extraInfo) {
  app.replaceChildren(frame(stepId, info, card, extraInfo));
  const first = card.querySelector("input:not([type=hidden]):not([disabled])");
  if (first) first.focus();
  window.scrollTo({ top: 0 });
}

function errorBox() {
  return h("div.error.hidden", { role: "alert" });
}
function showError(box, msg) {
  box.textContent = msg;
  box.classList.toggle("hidden", !msg);
}
function busy(btn, on, label) {
  btn.disabled = on;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.replaceChildren(h("span.spin"), label || "Working…");
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
  }
}

const LEVEL_TEXT = { good: "Good fit", warn: "Works, with limits", bad: "Not recommended", off: "Not available", info: "Note", yours: "Your choice" };
function levelChip(level, text) {
  return h(`span.chip.${level === "off" ? "muted" : level}`, h("span.dot"), text || LEVEL_TEXT[level] || level);
}

// ---- 0. setup code ------------------------------------------------------------------------------------------------

// P2 (assembly-038 / NEXT-ROUND): over plain http from outside the server's own network (a VPS owner's first page),
// nothing secret is typed: not the setup code, not the password. The server refuses it too (web.py _secret_ok); this
// page sends the owner to the server's own https setup page (a self-signed certificate whose fingerprint install.sh
// printed), or, where there is none, says how to come in through an SSH tunnel.
function viewPrivatePage() {
  const host = location.hostname; // an IPv6 address keeps its brackets here
  const port = status.proxyOnly ? "8080" : "80";
  const tunnel = h("p.muted", "Or come in through an SSH tunnel from your computer: ",
    h("code", `ssh -L 8080:127.0.0.1:${port} you@${host.replace(/^\[|\]$/g, "")}`), ", then open ", h("span.mono", "http://127.0.0.1:8080/"), ".");
  // the cut-down answer doesn't say whether there is an https page (follow-up review): offer it unless told there's none
  const card = status.secureSetup !== false
    ? h("div.card.stack-lg",
      h("div.stack-sm",
        h("h1", "Continue on the private setup page"),
        h("p.lede", "This page reaches your server over the internet without encryption, so the setup code and your password can't be typed here.")),
      h("div.row.wrap", h("a.btn.cta", { href: `https://${host}/` }, "Open the private setup page"), h("span.small.muted.mono", `https://${host}/`)),
      h("div.note", h("p", "Your browser will warn that it doesn't know the page's certificate: your server made it itself, because it has no certificate of its own yet."),
        h("p", "Before you continue past the warning, open the certificate's details and check that its SHA-256 fingerprint is the one the installer printed (", h("code", "sudo tinhat setup-code"), " on the server shows it again). If it isn't, stop: someone is in between.")),
      tunnel)
    : h("div.card.stack-lg",
      h("div.stack-sm",
        h("h1", "Set up from a private connection"),
        h("p.lede", "This page reaches your server over the internet without encryption, so the setup code and your password can't be typed here, and this server can't offer an https setup page.")),
      tunnel);
  show(null, INFO.unlockOwn, card);
}

function viewUnlock(message) {
  // the cut-down answer port 80 gives an outside address (OUTSIDE_STATUS_KEYS) has no plainOutside: plain http plus that
  // answer means outside too (Astra on 01b6fc4); the setup site serves https until setup is done
  if (status && !status.plainOutside && location.protocol === "http:" && outsideAnswer(status)) status.plainOutside = true;
  if (status && status.plainOutside) return viewPrivatePage();
  const err = errorBox();
  if (message) showError(err, message);
  const input = h("input.code", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "0000-0000", maxlength: "9", "aria-label": "Setup code" });
  input.addEventListener("input", () => {
    const d = input.value.replace(/\D/g, "").slice(0, 8);
    input.value = d.length > 4 ? `${d.slice(0, 4)}-${d.slice(4)}` : d;
    showError(err, "");
  });
  const go = h("button.btn.cta.block", { type: "submit" }, "Continue");
  const card = h("div.card.stack-lg",
    h("div.stack-sm",
      h("h1", "Set up your Tin Hat server"),
      h("p.lede", status && status.edition === "compose"
        ? ["The server printed an 8-digit setup code in its log (", h("code", "docker logs tinhat-manager"), "); ", h("code", "docker exec tinhat-manager tinhat setup-code"), " shows it again. Type it here to begin."]
        : status && status.edition === "linux"
        ? ["The installer printed an 8-digit setup code. On the server, ", h("code", "sudo tinhat setup-code"), " shows it again. Type it here to begin."]
        : status && status.platform === "windows"
          ? "The installer's last page showed an 8-digit setup code. The Tin Hat Server icon next to the clock shows it again (right-click it, then Show setup code). Type it here to begin."
          : "Your server shows an 8-digit setup code on its own screen. Type it here to begin.")),
    h("form.stack", {
      onsubmit: async (e) => {
        e.preventDefault();
        if (input.value.replace(/\D/g, "").length !== 8) return showError(err, "The setup code has 8 digits.");
        busy(go, true, "Checking…");
        try {
          await api("/admin/setup/unlock", { json: { code: input.value } });
          await boot();
        } catch (ex) {
          busy(go, false);
          showError(err, ex.message);
          input.select();
        }
      },
    }, h("label.field", h("span", "Setup code"), input), err, go),
    h("p.small.muted", "Setup takes about five minutes: a few questions, then an install that runs by itself."));
  show(null, status && (status.edition === "linux" || status.edition === "compose") ? INFO.unlockOwn : status && status.platform === "windows" ? INFO.unlockWin : INFO.unlock, card);
  if (handedCode && !message) {
    input.value = handedCode;
    go.focus();
  }
}

// ---- 1. check: measure the server and the network ------------------------------------------------------------------

function randomBlob(bytes) {
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 65536) crypto.getRandomValues(buf.subarray(i, Math.min(bytes, i + 65536)));
  return new Blob([buf]);
}

/** Run `parallel` copies of worker until `ms` has passed; returns Mbit/s over the whole run. */
async function measure(ms, parallel, worker) {
  let bytes = 0;
  const t0 = performance.now();
  const deadline = t0 + ms;
  await Promise.all(Array.from({ length: parallel }, () => worker(deadline, (n) => (bytes += n))));
  const secs = (performance.now() - t0) / 1000;
  return Math.round(((bytes * 8) / secs / 1e6) * 10) / 10;
}

async function netTest(onStage) {
  onStage("Timing the round trip…");
  const rtts = [];
  for (let i = 0; i < 8; i++) {
    const t = performance.now();
    await fetch("/admin/setup/speed/ping", { cache: "no-store", credentials: "same-origin" });
    rtts.push(performance.now() - t);
  }
  rtts.sort((a, b) => a - b);
  const rtt = Math.round(rtts[Math.floor(rtts.length / 2)] * 10) / 10;
  onStage("Downloading from the server…");
  const down = await measure(3000, 3, async (deadline, count) => {
    while (performance.now() < deadline) {
      const r = await fetch("/admin/setup/speed/down?mb=16", { cache: "no-store", credentials: "same-origin" });
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        count(value.length);
        if (performance.now() > deadline) {
          await reader.cancel();
          break;
        }
      }
    }
  });
  onStage("Uploading to the server…");
  const blob = randomBlob(4 << 20);
  const up = await measure(3000, 3, async (deadline, count) => {
    while (performance.now() < deadline) {
      const r = await fetch("/admin/setup/speed/up", { method: "POST", body: blob, credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" } });
      if (!r.ok) throw new Error(`upload test: ${r.status}`);
      count(blob.size);
    }
  });
  return { down, up, rtt };
}

function checkRow(label) {
  let icon = h("span.spin");
  const value = h("span.muted", "Waiting…");
  const chip = h("span");
  const text = h("div.s");
  const row = h("div.item.check", icon, h("div.grow", h("div.k", label, " ", value), text), chip);
  const swap = (el) => {
    icon.replaceWith(el);
    icon = el;
  };
  return {
    row,
    busy(msg) {
      if (!icon.classList.contains("spin")) swap(h("span.spin"));
      value.textContent = msg;
    },
    set(c) {
      swap(h(`span.lvl.${c.level}`, { "aria-hidden": "true" }));
      value.textContent = c.value;
      value.className = "val";
      text.textContent = c.text;
      chip.replaceChildren(levelChip(c.level, { good: "Good", warn: "OK", bad: "Too slow", info: "Note", off: "n/a" }[c.level]));
    },
  };
}

async function viewCheck(again) {
  const rows = { cpu: checkRow("Processor"), memory: checkRow("Memory"), disk: checkRow("Storage"), network: checkRow("Network"), internet: checkRow("Internet") };
  const headline = h("p.lede", "Measuring… this takes about fifteen seconds.");
  const next = h("button.btn.cta", { type: "button", disabled: true }, "Continue");
  const rerun = h("button.btn.ghost", { type: "button", disabled: true }, "Run the tests again");
  const err = errorBox();
  next.addEventListener("click", viewFeatures);
  rerun.addEventListener("click", () => viewCheck(true));
  const card = h("div.card.stack-lg",
    h("div.stack-sm", h("h1", "Checking your server"), headline),
    h("div.list", Object.values(rows).map((r) => r.row)),
    err,
    h("div.row.end", rerun, next));
  show("check", INFO.check, card);

  let net = null;
  try {
    rows.cpu.busy("Testing…");
    rows.disk.busy("Testing…");
    rows.memory.busy("Reading…");
    rows.internet.busy("Checking…");
    rows.network.busy("Waiting for the server tests…");
    await api("/admin/setup/bench", { method: "POST" });
    rows.cpu.busy("Measured");
    rows.disk.busy("Measured");
    try {
      net = await netTest((msg) => rows.network.busy(msg));
    } catch (ex) {
      net = null;
    }
    assessment = await api("/admin/setup/assess", { json: { net } });
  } catch (ex) {
    if (ex.status === 401) return viewUnlock("The server restarted. Enter the setup code again to carry on.");
    showError(err, ex.message);
    rerun.disabled = false;
    return;
  }
  const a = assessment.advice;
  for (const c of a.checks) rows[c.id] && rows[c.id].set(c);
  headline.textContent = a.headline;
  if (!a.ready) showError(err, "Give this machine at least 2 GB of memory and 4 GB of free disk, restart it, and open this page again.");
  if (!again || !answers.features) answers.features = recommended(a);
  next.disabled = !a.ready;
  rerun.disabled = false;
  next.focus();
}

function recommended(a) {
  const f = Object.fromEntries(a.features.map((x) => [x.id, x.control]));
  return {
    calls: !!f.calls.recommended,
    previews: !!f.previews.recommended,
    directory: !!f.directory.recommended,
    uploadMb: f.uploads.recommended,
  };
}

// ---- 2. features: green / yellow / red, the reason, the choice --------------------------------------------------------

function toggleSwitch(on, disabled, onChange, label) {
  const sw = h("button.switch", { type: "button", role: "switch", "aria-checked": String(on), "aria-label": label, disabled });
  sw.addEventListener("click", () => {
    const v = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(v));
    onChange(v);
  });
  return sw;
}

function viewFeatures() {
  if (!assessment) return viewCheck();
  const a = assessment.advice;
  const f = answers.features || (answers.features = recommended(a));
  const rows = a.features.map((feat) => {
    const warnText = feat.id === "calls" ? "No voice or video calls on this server. Everything else still works." : "Not recommended on this machine; it may be slow.";
    const warnLine = h("div.s.warn-text.hidden", warnText);
    const showWarn = (on) => warnLine.classList.toggle("hidden", feat.id === "calls" ? on : !(on && feat.level === "bad"));
    let control;
    const c = feat.control;
    if (c.type === "toggle") {
      const key = feat.id;
      control = toggleSwitch(!!f[key], !!c.locked, (v) => {
        f[key] = v;
        showWarn(v);
      }, feat.name);
      showWarn(!!f[key]);
    } else if (c.type === "select") {
      control = h("select", { "aria-label": feat.name }, c.options.map((o) => h("option", { value: String(o.value), selected: o.value === f.uploadMb ? "" : null }, o.label + (o.value === c.recommended ? " (recommended)" : ""))));
      control.addEventListener("change", () => (f.uploadMb = Number(control.value)));
    } else if (c.type === "always") {
      control = h("span.chip.good", "Always on");
    } else if (c.type === "soon") {
      control = h("span.chip.accent", "Coming soon");
    } else {
      control = h("span.chip", "Automatic");
    }
    return h(`div.item.feature.lv-${feat.level}`,
      h(`span.lvl.${feat.level}`, { "aria-hidden": "true" }),
      h("div.grow",
        h("div.row.wrap.tight", h("span.k", feat.name), c.type === "soon" ? null : levelChip(feat.level)),
        h("div.s", feat.what),
        h("div.reason", feat.reason),
        warnLine),
      h("div.ctl", control));
  });
  const legend = h("div.legend",
    levelChip("good"), levelChip("warn"), levelChip("bad"), levelChip("off", "Not available yet"), levelChip("yours"));
  const card = h("div.card.stack-lg",
    h("div.stack-sm",
      h("h1", "What should your server run?"),
      h("p.lede", "Based on the check. The recommended choices are already set; change anything you like.")),
    legend,
    h("div.list.features", rows),
    h("div.row.end",
      h("button.btn.ghost", { type: "button", onclick: () => viewCheck(true) }, "Back"),
      h("button.btn.cta", { type: "button", onclick: viewConnect }, "Continue")));
  show("features", INFO.features, card);
}

// ---- 3. name -------------------------------------------------------------------------------------------------------

function viewConnect() {
  const err = errorBox();
  const pick = (mode) => {
    answers.mode = mode;
    lan.setAttribute("aria-checked", String(mode === "lan"));
    wan.setAttribute("aria-checked", String(mode === "anywhere"));
    own.setAttribute("aria-checked", String(mode === "domain"));
    ownBox.classList.toggle("hidden", mode !== "domain");
    nameField.classList.toggle("hidden", mode === "domain");
    codeField.classList.toggle("hidden", mode !== "anywhere" || !inviteOnly);
    suffix.textContent = mode === "anywhere" ? `.${zone}` : ".local";
    nameWrap.classList.toggle("wide", mode === "anywhere");
    if (mode === "anywhere" && nameIn.value === "home") nameIn.value = "";
    updateHelp();
    schedule();
    showError(err, "");
  };
  const lan = h("button.choice", { type: "button", role: "radio", "aria-checked": String(answers.mode === "lan"), onclick: () => pick("lan") },
    h("div.t", "People in my home"),
    h("div.d", "Everyone connects on your home network (your Wi-Fi). Nothing is opened to the internet. Each device trusts the server once."));
  const wanNote = h("div.d", "Friends connect from their own homes. Your server gets a real address and certificate, and opens three ports on your router. Needs a server code while names are new.");
  const wan = h("button.choice", { type: "button", role: "radio", "aria-checked": String(answers.mode === "anywhere"), disabled: true, onclick: () => pick("anywhere") },
    h("div.t", "Friends anywhere", h("span.chip.muted", "checking…")), wanNote);
  const own = h("button.choice", { type: "button", role: "radio", "aria-checked": String(answers.mode === "domain"), onclick: () => pick("domain") },
    h("div.t", "My own domain", h("span.chip.muted", "Advanced")),
    h("div.d", "For people who own a domain (with DNS at Cloudflare, Porkbun, deSEC or DuckDNS), or who already run a reverse proxy. Your server is at an address like chat.example.com and nothing depends on tinhat.me."));
  const od = answers.domain || { provider: "cloudflare" };
  const domIn = h("input", { type: "text", value: answers.mode === "domain" ? answers.name : "", placeholder: "chat.example.com", autocomplete: "off", autocapitalize: "none", spellcheck: "false" });
  const provSel = h("select", { "aria-label": "DNS provider" }, Object.entries(OWN_PROVIDERS).map(([k, v]) => h("option", { value: k, selected: k === od.provider ? "" : null }, v.label)));
  const credBox = h("div.stack-sm");
  const credIn = {};
  const dnsNote = h("small.muted", "With a DNS provider, the certificate comes from Let's Encrypt through its API, so no port needs to be open for it. The API details stay on your server.");
  const drawCreds = () => {
    const pv = OWN_PROVIDERS[provSel.value];
    dnsNote.classList.toggle("hidden", provSel.value === "proxy");
    credBox.replaceChildren(...pv.fields.map(([k, label]) => {
      credIn[k] = credIn[k] || h("input", { type: "password", autocomplete: "off", spellcheck: "false", value: od[k] || "" });
      return h("label.field", h("span", `${pv.label} ${label}`), credIn[k]);
    }), h("small", pv.help));
  };
  provSel.addEventListener("change", drawCreds);
  drawCreds();
  const ownBox = h("div.stack-sm.hidden",
    h("label.field", h("span", "Your server's address"), domIn, h("small", "A name in a domain you own, like chat.example.com. People's addresses will look like @alex:chat.example.com. The server can move to another domain later, from its dashboard.")),
    h("label.field", h("span", "Where the domain's DNS is, or who handles HTTPS"), provSel),
    credBox,
    dnsNote);
  const codeIn = h("input", { type: "text", value: answers.code || "", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", placeholder: "TN-XXXX-XXXX", "aria-describedby": "code-help" });
  const codeHelp = h("small", { id: "code-help" }, "From whoever gave you Tin Hat. One code makes one server.");
  const codeField = h("label.field.hidden", h("span", "Server code"), codeIn, codeHelp);
  const nameIn = h("input", { type: "text", value: answers.mode === "domain" ? "home" : answers.name || (answers.mode === "anywhere" ? "" : "home"), autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-describedby": "name-help" });
  const suffix = h("b", answers.mode === "anywhere" ? `.${zone}` : ".local");
  const nameWrap = h(`div.suffix${answers.mode === "anywhere" ? ".wide" : ""}`, nameIn, suffix);
  const help = h("small", { id: "name-help" });
  const avail = h("small.avail");
  const nameField = h("label.field", h("span", "Server name"), nameWrap, help, avail);
  let inviteOnly = true;
  let checkTimer = 0;
  let lastOk = false;
  const updateHelp = () => {
    const n = nameIn.value.trim().toLowerCase() || "name";
    help.textContent = answers.mode === "anywhere"
      ? `Your server will be at ${n}.${zone}; friends just type “${n}”. Addresses look like @alex:${n}.${zone}. The name can't be changed, but the server can move to a domain of your own later.`
      : `Your server will be at ${n}.local and people's addresses will look like @alex:${n}.local. The name can't be changed, but the server can move to a domain of your own later.`;
  };
  const schedule = () => {
    clearTimeout(checkTimer);
    avail.textContent = "";
    avail.className = "avail";
    lastOk = false;
    if (answers.mode !== "anywhere") return;
    checkTimer = setTimeout(async () => {
      const n = nameIn.value.trim().toLowerCase();
      if (n.length < 4) {
        avail.textContent = n ? "Use at least 4 characters." : "";
        return;
      }
      const code = codeIn.value.trim().toUpperCase();
      try {
        const r = await api(`/admin/setup/names?name=${encodeURIComponent(n)}${inviteOnly && code ? `&code=${encodeURIComponent(code)}` : ""}`);
        if (n !== nameIn.value.trim().toLowerCase()) return;
        if (!r.online) {
          avail.textContent = r.message || "Can't reach the Tin Hat names service.";
          avail.className = "avail warn-text";
          return;
        }
        lastOk = !!r.ok;
        avail.textContent = r.ok ? `✓ ${r.fqdn} is free` : `✗ ${r.message}`;
        avail.className = `avail ${r.ok ? "good-text" : "warn-text"}`;
        if (inviteOnly && code) {
          codeHelp.textContent = r.codeOk ? "✓ Code accepted." : "✗ That code isn't valid (or was already used).";
          codeHelp.className = r.codeOk ? "good-text" : "warn-text";
        }
      } catch (ex) {
        if (ex.status === 401) return viewUnlock("The server restarted. Enter the setup code again to carry on.");
        avail.textContent = ex.message;
      }
    }, 450);
  };
  nameIn.addEventListener("input", () => {
    nameIn.value = nameIn.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    updateHelp();
    schedule();
    showError(err, "");
  });
  codeIn.addEventListener("input", () => {
    codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
    schedule();
  });
  updateHelp();
  // Is the names service reachable from this server? Only then is "Friends anywhere" offered.
  api("/admin/setup/names").then((r) => {
    const chip = $(".chip", wan);
    if (r.online) {
      zone = r.zone || zone;
      inviteOnly = r.inviteOnly !== false;
      wan.disabled = !!(status && status.proxyOnly);
      chip.replaceWith(h("span.chip.accent", inviteOnly ? "Server code" : "Available"));
      if (answers.mode === "anywhere") pick("anywhere");
    } else {
      chip.replaceWith(h("span.chip.muted", "Needs internet"));
      wanNote.textContent = "This server can't reach the Tin Hat names service right now, so only the home network is possible. Check its internet connection, then come back to this step.";
      if (answers.mode === "anywhere") pick("lan");
    }
  }).catch(() => {});
  const card = h("form.card.stack-lg", {
    onsubmit: (e) => {
      e.preventDefault();
      const n = nameIn.value.trim();
      if (answers.mode === "domain") {
        const d = domIn.value.trim().toLowerCase().replace(/\.$/, "");
        if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d))
          return showError(err, "Type the full address for your server, like chat.example.com.");
        if (d.endsWith(".local") || d === zone || d.endsWith(`.${zone}`))
          return showError(err, `Use a domain you own. For a name under ${zone}, choose Friends anywhere.`);
        if (provSel.value === "duckdns" && !d.endsWith(".duckdns.org"))
          return showError(err, "With DuckDNS, the address is one of yours under duckdns.org, like crew.duckdns.org.");
        const pv = OWN_PROVIDERS[provSel.value];
        const dom = { provider: provSel.value };
        for (const [k, label] of pv.fields) {
          dom[k] = (credIn[k].value || "").trim();
          if (!dom[k]) return showError(err, `Paste your ${pv.label} ${label}.`);
        }
        answers.name = d;
        answers.domain = dom;
        return viewAccount();
      }
      if (answers.mode === "anywhere") {
        if (!/^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(n) || n.includes("--"))
          return showError(err, "Use 4 to 32 lowercase letters, numbers or single dashes (not at the start or end).");
        const code = codeIn.value.trim().toUpperCase();
        if (inviteOnly && !/^TN-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) return showError(err, "Enter the server code you were given (TN-XXXX-XXXX).");
        if (!lastOk) return showError(err, "Wait for the name check, or pick a name that's free.");
        answers.code = code;
      } else if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/.test(n) || n.length < 2) {
        return showError(err, "Use 2 to 30 lowercase letters, numbers or dashes (not at the start or end).");
      }
      answers.name = n;
      viewAccount();
    },
  },
  h("div.stack-sm", h("h1", "Name your server"), h("p.lede", "And choose who connects to it.")),
  h("div.choices", { role: "radiogroup", "aria-label": "Who connects" }, lan, wan, own),
  codeField,
  nameField,
  ownBox,
  err,
  h("div.row.end", h("button.btn.ghost", { type: "button", onclick: viewFeatures }, "Back"), h("button.btn.cta", { type: "submit" }, "Continue")));
  show("name", INFO.name, card);
  if (status && status.proxyOnly) {
    // install.sh --behind-proxy: this machine's own web server has ports 80 and 443, so only the reverse-proxy way works
    lan.disabled = true;
    provSel.value = "proxy";
    provSel.disabled = true;
    drawCreds();
    pick("domain");
    card.querySelector(".choices").after(h("p.small.muted", "Another web server on this machine (your reverse proxy) has ports 80 and 443, so Tin Hat Server runs behind it: your proxy sends your domain to this server. That's why the other two are off."));
    return;
  }
  if (answers.mode === "anywhere") pick("anywhere");
  if (answers.mode === "domain") pick("domain");
}

// ---- 4. admin account ------------------------------------------------------------------------------------------------

// Who can open the dashboard (access.py): asked only for a server friends reach from outside, and only when this browser
// isn't on the server's own network (a VPS owner at home, say). The address is the one the server saw; "Only from the
// home network" isn't offered from outside: it would close the dashboard on the owner at the end of setup.
const ownerOutside = () => publicMode(answers.mode) && !!(status && status.owner && status.owner.address && !status.owner.atHome);
const accessWords = (choice) => choice === "address" ? `Only from ${status.owner.address}` : "Anywhere, with your password";

function accessChoice() {
  const o = status.owner;
  const net = o.address.includes("/");
  const pick = (v) => {
    answers.dashboardAccess = v;
    for (const b of [any, mine]) b.setAttribute("aria-checked", String(b.dataset.v === v));
  };
  const any = h("button.choice", { type: "button", role: "radio", "data-v": "anywhere", onclick: () => pick("anywhere") },
    h("div.t", "Anywhere, with your password"),
    h("div.d", "How every Tin Hat server starts. Handy if you'll look after it from different places: home, work, your phone."));
  const mine = h("button.choice", { type: "button", role: "radio", "data-v": "address", onclick: () => pick("address") },
    h("div.t", net ? "Only from this network" : "Only from this address"),
    h("div.d", net ? ["Only from addresses in ", h("span.mono", o.address), " (where you are now) and the server's own network."]
      : ["Only from ", h("span.mono", o.address), " (where you are now) and the server's own network."]),
    h("div.d", "If your internet provider gives you a new address, you'll need the server's console to open the dashboard again: ",
      h("code", "sudo tinhat dashboard-access anywhere"), "."));
  pick(answers.dashboardAccess === "address" ? "address" : "anywhere");
  return h("div.stack-sm",
    h("h2", "Who can open the dashboard"),
    h("p.muted", ["You're setting this up from ", h("span.mono", o.address), ", which isn't on the server's own network. Who should be able to open its dashboard?"]),
    h("div.choices", { role: "radiogroup", "aria-label": "Who can open the dashboard" }, any, mine),
    h("p.small.muted", "Chat, calls and the Tin Hat apps' invite codes work from anywhere either way. You can change this later under Network, and choose “only from the home network” there."));
}

function viewAccount() {
  const err = errorBox();
  const sn = serverName();
  const disp = h("input", { type: "text", value: answers.admin.displayName, autocomplete: "name", placeholder: "e.g. Alex Kim" });
  const user = h("input", { type: "text", value: answers.admin.username, autocomplete: "username", autocapitalize: "none", spellcheck: "false", placeholder: "e.g. alex" });
  const pw = h("input", { type: "password", autocomplete: "new-password" });
  const pw2 = h("input", { type: "password", autocomplete: "new-password" });
  const idHelp = h("small");
  const upd = () => (idHelp.textContent = `You'll sign in as @${user.value.trim().toLowerCase() || "username"}:${sn}`);
  user.addEventListener("input", () => {
    user.value = user.value.toLowerCase().replace(/\s/g, "");
    upd();
  });
  disp.addEventListener("input", () => {
    if (!user.dataset.touched) {
      user.value = disp.value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9._-]/g, "");
      upd();
    }
  });
  user.addEventListener("keydown", () => (user.dataset.touched = "1"));
  upd();
  const card = h("form.card.stack-lg", {
    onsubmit: (e) => {
      e.preventDefault();
      const u = user.value.trim().toLowerCase();
      if (!disp.value.trim()) return showError(err, "Enter your name.");
      if (!/^[a-z0-9._=\-/+]+$/.test(u)) return showError(err, "Usernames are lowercase letters, numbers, dots, dashes and underscores.");
      if (pw.value.length < 8) return showError(err, "Use a password of at least 8 characters.");
      if (pw.value !== pw2.value) return showError(err, "The two passwords don't match.");
      answers.admin = { displayName: disp.value.trim(), username: u, password: pw.value };
      viewReview();
    },
  },
  h("div.stack-sm", h("h1", "Create your admin account"), h("p.lede", "Your own Tin Hat account, which also opens the server's dashboard.")),
  h("label.field", h("span", "Your name"), disp),
  h("label.field", h("span", "Username"), user, idHelp),
  h("label.field", h("span", "Password"), pw, h("small", "At least 8 characters. This server can't email you a reset link, so keep it somewhere safe.")),
  h("label.field", h("span", "Password again"), pw2),
  ownerOutside() ? accessChoice() : null,
  err,
  h("div.row.end", h("button.btn.ghost", { type: "button", onclick: viewConnect }, "Back"), h("button.btn.cta", { type: "submit" }, "Continue")));
  if (!ownerOutside()) answers.dashboardAccess = "anywhere";
  show("account", INFO.account, card);
}

// ---- 5a. review ------------------------------------------------------------------------------------------------------

function featureSummary() {
  const f = answers.features || {};
  const up = f.uploadMb >= 1000 ? `${f.uploadMb / 1000} GB` : `${f.uploadMb} MB`;
  return [
    ["Voice and video calls", f.calls ? "On" : "Off"],
    ["Link previews", f.previews ? "On" : "Off"],
    ["Biggest file people can send", up],
    ["Find people by name", f.directory ? "On" : "Off"],
  ];
}

function viewReview() {
  const err = errorBox();
  const sn = serverName();
  const rows = [
    ["Server address", sn],
    ["Who connects", answers.mode === "anywhere" ? `Friends anywhere (they type “${answers.name}”)` : answers.mode === "domain" ? (!answers.domain ? "Friends anywhere, at your own domain (as set up before)" : answers.domain.provider === "proxy" ? "Friends anywhere, at your own domain, through your own reverse proxy" : `Friends anywhere, at your own domain (${OWN_PROVIDERS[answers.domain.provider].label})`) : "People on this home network"],
    ["Admin account", `${answers.admin.displayName} (@${answers.admin.username}:${sn})`],
    ...(ownerOutside() ? [["Dashboard opens from", accessWords(answers.dashboardAccess)]] : []),
    ...featureSummary(),
  ];
  const go = h("button.btn.cta", { type: "button" }, "Install Tin Hat Server");
  go.addEventListener("click", async () => {
    busy(go, true, "Starting…");
    try {
      await api("/admin/setup/install", { json: answers });
      viewProgress();
    } catch (ex) {
      busy(go, false);
      if (ex.status === 401) return viewUnlock("The server restarted. Enter the setup code again to carry on.");
      showError(err, ex.message);
    }
  });
  const card = h("div.card.stack-lg",
    h("div.stack-sm", h("h1", "Ready to install"), h("p.lede", publicMode(answers.mode)
      ? "Check the details. Installing usually takes 1–3 minutes: it also gets a certificate, opens ports on your router and checks from outside. Keep this page open."
      : "Check the details. Installing takes about a minute; keep this page open.")),
    h("div.list", rows.map(([k, v]) => h("div.item", h("div.grow", h("div.s", k), h("div.k", v))))),
    err,
    h("div.row.end", h("button.btn.ghost", { type: "button", onclick: viewAccount }, "Back"), go));
  show("install", INFO.review, card);
}

// ---- 5b. progress ------------------------------------------------------------------------------------------------------

let restoring = null; // {source, password, snapshot}: Try again restores again instead of installing
let pollTimer = 0;
let lostSince = 0;
let lastSteps = [];

function iconFor(st) {
  if (st === "running") return h("span.spin");
  const map = { done: ["done", ICON.check], failed: ["failed", ICON.cross], skipped: ["skipped", ICON.dash], warn: ["warn", ICON.dash], ask: ["warn", ICON.dash] };
  const [cls, svg] = map[st] || ["pending", ""];
  return h(`span.ico.${cls}`, { html: svg });
}

function viewProgress() {
  const sn = answers.name ? serverName() : (status && status.serverName) || "your server";
  const isRestore = !!(restoring || (status && status.restoring)); // also after a reload in the middle of one
  const bar = h("i");
  const list = h("div.list.progress");
  const err = errorBox();
  const retry = h("button.btn.cta.hidden", { type: "button" }, "Try again");
  const foot = h("p.small.muted", publicMode(answers.mode) ? "This usually takes 1–3 minutes. Keep this page open." : "This takes about a minute. Keep this page open.");
  const another = h("button.btn.ghost.hidden", { type: "button", onclick: () => { restoring = null; viewRestore(); } }, "Choose another backup");
  retry.addEventListener("click", async () => {
    if (!restoring && isRestore) return viewRestore(); // reloaded mid-restore: the backup password isn't kept anywhere
    if (!restoring && !answers.admin.password) return viewAccount(); // reloaded: the password isn't kept anywhere
    busy(retry, true, "Starting…");
    try {
      await api(restoring ? "/admin/setup/restore/start" : "/admin/setup/install", { json: restoring || answers });
      retry.classList.add("hidden");
      showError(err, "");
      poll();
    } catch (ex) {
      busy(retry, false);
      if (ex.status === 401) return viewUnlock("The server restarted. Enter the setup code again to carry on.");
      showError(err, ex.message);
    }
  });
  const qbox = h("div", { "aria-live": "polite" });
  const card = h("div.card.stack-lg",
    h("div.stack-sm", h("h1", isRestore ? `Restoring ${sn}` : `Setting up ${sn}`),
      h("p.lede", isRestore ? "Your server is coming back from the backup." : "Your server is installing everything it needs.")),
    h("div.bar", bar),
    list, qbox, err, foot,
    h("div.row.end", another, retry));
  show(isRestore ? null : "install", isRestore ? INFO.restore : INFO.review, card);

  const render = (prog) => {
    const steps = prog.steps || [];
    lastSteps = steps;
    const done = steps.filter((s) => ["done", "skipped", "warn"].includes(s.status)).length;
    bar.style.width = `${Math.round((100 * done) / Math.max(1, steps.length))}%`;
    list.replaceChildren(...steps.map((s) =>
      h(`div.item${s.status === "running" ? ".running" : ""}`, iconFor(s.status),
        h("div.grow", h("div.k", s.label),
          s.status === "running" && (s.detail || STEP_INFO[s.id]) ? h("div.s", s.detail || STEP_INFO[s.id]) : null,
          s.detail && ["skipped", "warn", "ask"].includes(s.status) ? h(`div.s${s.status !== "skipped" ? ".warn-text" : ""}`, s.detail) : null,
          s.detail && s.status === "done" && ["name", "ports", "outside", "secure"].includes(s.id) ? h("div.s", s.detail) : null))));
  };

  // A question from the install (behind carrier NAT: "use the Tin Hat relay?"); the install waits for the answer.
  const renderQuestion = (q) => {
    if (!q) {
      if (qbox.dataset.q) qbox.replaceChildren();
      delete qbox.dataset.q;
      return;
    }
    if (qbox.dataset.q === q.id) return;
    qbox.dataset.q = q.id;
    const qerr = errorBox();
    const yes = h("button.btn.cta", { type: "button" }, q.yes);
    const no = h("button.btn.ghost", { type: "button" }, q.no);
    const send = async (use, btn) => {
      busy(btn, true, use ? "Connecting…" : "Carrying on…");
      (use ? no : yes).disabled = true;
      try {
        await api("/admin/setup/relay", { json: { use } });
      } catch (ex) {
        busy(btn, false);
        yes.disabled = no.disabled = false;
        showError(qerr, ex.message);
      }
    };
    yes.addEventListener("click", () => send(true, yes));
    no.addEventListener("click", () => send(false, no));
    qbox.replaceChildren(h("div.card.flat.stack-sm", h("h3", q.title), ...q.lines.map((l) => h("p.muted", l)), qerr,
      h("div.row.wrap", yes, no)));
    yes.focus();
  };

  const poll = async () => {
    clearTimeout(pollTimer);
    let st;
    try {
      st = await api("/admin/setup/status");
      lostSince = 0;
    } catch (ex) {
      // The box renames itself (tinhat.local → <name>.local) a few seconds after it finishes, so losing it
      // once the last step has started means it's done. Losing it any earlier is a real problem: say so.
      if (!lostSince) lostSince = Date.now();
      const finishing = lastSteps.some((s) => s.id === "finish" && (s.status === "running" || s.status === "done"));
      if (finishing && Date.now() - lostSince > 5000) return viewDone(true);
      if (!finishing && Date.now() - lostSince > 20000) {
        showError(err, "Lost touch with the server. It may be restarting — this page keeps trying. If it stays like this, check that the server is still on.");
      }
      pollTimer = setTimeout(poll, 1500);
      return;
    }
    if (lostSince === 0) showError(err, "");
    status = st;
    if (st.phase === "ready") return isPublic(st) ? viewDoneAnywhere() : viewDone(false);
    if (st.progress) {
      render(st.progress);
      renderQuestion(st.progress.question);
    }
    if (st.addresses) addresses = st.addresses;
    if (st.phase === "failed" && !(st.progress && st.progress.running)) {
      const details = st.errorDetails || (st.progress && st.progress.details) || "";
      err.replaceChildren(...[
        h("div", st.error || (st.progress && st.progress.error) || "Setup stopped.", " Press Try again — setup picks up where it stopped."),
        details ? h("details.tech", h("summary", "Technical details"), h("pre", details)) : null,
      ].filter(Boolean));
      err.classList.remove("hidden");
      busy(retry, false); // it failed again after a Try again: the button works again, labelled as before
      retry.classList.remove("hidden");
      another.classList.toggle("hidden", !isRestore);
      foot.classList.add("hidden");
      return;
    }
    pollTimer = setTimeout(poll, 1000);
  };
  poll();
}

// ---- after a restore: the admin password is the one the backup had --------------------------------------------------

/** The "sign in" line of the last page: the password just chosen, or after a restore, the one from the backup's day
 * with a way to set a new one right here (the owner may have changed it after the copy was made). */
function signInLine(admin) {
  const rf = status && status.restoredFrom;
  if (!rf) return h("p.muted", `Sign in as ${admin} with the password you just chose.`);
  const when = rf.backupTime ? dateText(Date.parse(rf.backupTime)) : "the day the backup was made";
  const p1 = h("input", { type: "password", autocomplete: "new-password" });
  const p2 = h("input", { type: "password", autocomplete: "new-password" });
  const err = h("div.error.hidden");
  const save = h("button.btn.ghost.small", { type: "submit" }, "Set this password");
  const form = h("form.stack-sm.hidden", {
    onsubmit: async (e) => {
      e.preventDefault();
      if (p1.value.length < 8) return showError(err, "Use a password of at least 8 characters.");
      if (p1.value !== p2.value) return showError(err, "The two passwords don't match.");
      busy(save, true, "Saving…");
      try {
        const r = await api("/admin/setup/restore/password", { json: { password: p1.value } });
        form.replaceChildren(h("p.small.good-text", `Done: sign in as ${r.mxid} with the new password.`));
      } catch (ex) { busy(save, false); showError(err, ex.message); }
    },
  }, h("label.field", h("span", "New admin password"), p1), h("label.field", h("span", "The same again"), p2), err, h("div.row", save));
  const open = h("a", { href: "#", onclick: (e) => { e.preventDefault(); form.classList.remove("hidden"); open.remove(); p1.focus(); } }, "Set a new admin password now");
  return h("div.stack-sm",
    h("p.muted", `Everything is as it was in the backup from ${when}, the admin password included: sign in with the password your admin account had then.`),
    h("p.small.muted", "Changed it after that backup? ", open),
    form);
}

// ---- the first choice: a new server, or one from a backup ---------------------------------------------------------

function viewStart() {
  const pick = (title, text, go) => h("button.choice", { type: "button", onclick: go }, h("div.t", title), h("div.d", text));
  const card = h("div.card.stack-lg",
    h("div.stack-sm", h("h1", "Set up your Tin Hat server"), h("p.lede", "Start a new server, or bring one back from a backup.")),
    h("div.choices",
      pick("Set up a new server", "A few questions, then it installs by itself.", () => viewCheck()),
      pick("Restore from a backup", "The same server comes back: its name, people, rooms and messages. Use this when you move to a new computer.", () => viewRestore())));
  show(null, INFO.start, card);
}

async function viewRestore() {
  const err = errorBox();
  const sources = h("div.list", h("div.item", h("span.spin"), h("span.muted", "Looking for backups on plugged-in drives…")));
  const pw = h("input", { type: "password", autocomplete: "off", "aria-label": "Backup password" });
  const open = h("button.btn.cta", { type: "button" }, "Open the backup");
  const file = h("input", { type: "file", accept: ".tar" });
  const upload = h("button.btn.ghost.small", { type: "button" }, "Upload");
  const snaps = h("div.stack-sm");
  let chosen = null;
  const back = h("button.btn.ghost", { type: "button", onclick: () => viewStart() }, "Back");

  const load = async () => {
    let r;
    try { r = await api("/admin/setup/restore/sources"); } catch (ex) { return showError(err, ex.message); }
    const opts = [];
    for (const d of r.drives) {
      for (const sv of d.servers) opts.push({ label: sv, sub: `${d.label || d.model || "USB drive"} · ${gb(d.size)}`, source: { type: "usb", uuid: d.uuid, server: sv } });
    }
    for (const sv of r.uploaded) opts.push({ label: sv, sub: "Uploaded file", source: { type: "upload", server: sv } });
    if (!opts.length) {
      sources.replaceChildren(h("div.item", h("div.grow", h("div.k", "No backups found on plugged-in drives"),
        h("div.s", "Plug in the USB drive with your backups and press Look again, or upload a backup file below."))),
      h("div.item", h("button.btn.ghost.small", { type: "button", onclick: load }, "Look again")));
      return;
    }
    sources.classList.replace("list", "choices");
    sources.replaceChildren(...opts.map((o, i) => {
      const b = h("button.choice", { type: "button", role: "radio", "aria-checked": String(i === 0) },
        h("div.t", o.label), h("div.d", o.sub));
      b.addEventListener("click", () => { chosen = o.source; sources.querySelectorAll(".choice").forEach((x) => x.setAttribute("aria-checked", String(x === b))); });
      return b;
    }));
    chosen = opts[0].source;
  };
  upload.addEventListener("click", async () => {
    if (!file.files.length) return showError(err, "Choose the backup file first.");
    busy(upload, true, "Uploading…");
    try {
      await api("/admin/setup/restore/upload", { method: "POST", body: file.files[0], headers: { "X-Tinhat": "1", "Content-Type": "application/octet-stream" } });
      showError(err, "");
      await load();
    } catch (ex) { showError(err, ex.message); }
    busy(upload, false);
  });
  open.addEventListener("click", async () => {
    if (!chosen) return showError(err, "Pick a backup first.");
    busy(open, true, "Opening…");
    try {
      const r = await api("/admin/setup/restore/open", { json: { source: chosen, password: pw.value } });
      showError(err, "");
      let snap = r.snapshots[0] && r.snapshots[0].id;
      const items = r.snapshots.map((x, i) => {
        const m = x.meta || {};
        const c = m.counts || {};
        const b = h("button.choice", { type: "button", role: "radio", "aria-checked": String(i === 0) },
          h("div.t", `${dateTimeText(Date.parse(x.time))}${i === 0 ? " (newest)" : ""}`),
          h("div.d", `${m.server_name || "?"} · Tin Hat Server ${m.version || "?"}` + (c.people !== undefined ? ` · ${plural(c.people, "person", "people")}, ${plural(c.rooms, "room", "rooms")}, ${plural(c.messages, "message", "messages")}` : "")));
        b.addEventListener("click", () => { snap = x.id; items.forEach((y) => y.setAttribute("aria-checked", String(y === b))); });
        return b;
      });
      const go = h("button.btn.cta", { type: "button" }, "Restore this server");
      go.addEventListener("click", async () => {
        busy(go, true, "Starting…");
        try {
          restoring = { source: chosen, password: pw.value, snapshot: snap };
          const s = await api("/admin/setup/restore/start", { json: restoring });
          status = { ...(status || {}), serverName: s.serverName, mode: s.mode };
          answers.mode = s.mode;
          viewProgress();
        } catch (ex) {
          busy(go, false);
          restoring = null;
          if (ex.body && ex.body.code === "needs-update") return snaps.replaceChildren(updateFirst(ex.message, ex.body.version));
          showError(err, ex.message);
        }
      });
      snaps.replaceChildren(h("h2", "Which copy?"), h("div.choices", items),
        h("p.small.muted", "The server comes back exactly as it was at that moment. Anything newer than the copy isn't in it."),
        h("div.row.end", go));
      busy(open, false);
    } catch (ex) { busy(open, false); showError(err, ex.message); }
  });
  const card = h("div.card.stack-lg",
    h("div.stack-sm", h("h1", "Restore from a backup"),
      h("p.lede", "Your server comes back with its name, people, rooms and messages. If it was reachable from anywhere, its name moves to this computer and the old one stops using it.")),
    h("div.stack-sm", h("h2", "Where's the backup?"), sources,
      h("div.row.wrap", file, upload), h("p.small.muted", "A downloaded backup is a .tar file (Dashboard → Maintenance → Download a copy).")),
    h("label.field", h("span", "Backup password"), pw, h("small", "The password chosen when backups were set up. Without it a backup can't be opened, by anyone.")),
    err, h("div.row.end", back, open), snaps);
  show(null, INFO.restore, card);
  load();
}

/** A backup from a newer Tin Hat Server: this computer updates itself first (its database may not open in an older
 * version), then the owner picks the copy again. The manager restarts during the update; the page follows it. */
function updateFirst(why, need) {
  const err = errorBox();
  const go = h("button.btn.cta", { type: "button" }, "Update this computer");
  const progress = h("div.stack-sm");
  const box = h("div.card.stack", h("h2", "Update this computer first"), h("p", why), progress, err, h("div.row.end", go));
  const steps = { downloading: "Downloading the newer version…", staged: "Downloaded.", installing: "Installing (this page may lose touch with the server for a moment)…" };
  go.addEventListener("click", async () => {
    busy(go, true, "Updating…");
    showError(err, "");
    try {
      await api("/admin/setup/update", { json: {} });
    } catch (ex) { busy(go, false); return showError(err, ex.message); }
    const started = Date.now();
    const poll = async () => {
      let st = null;
      try { st = await api("/admin/setup/status"); } catch { /* restarting */ }
      if (st && st.version && !updateNeeded(need, st.version)) {
        status = st;
        $("#meta").textContent = `version ${st.version}`;
        progress.replaceChildren(h("p.ok", `Updated to Tin Hat Server ${st.version}. Pick the copy again and type the backup password.`));
        return setTimeout(() => viewRestore(), 2500);
      }
      try {
        const u = await api("/admin/setup/update");
        const ph = (u.status && u.status.phase) || "";
        if (["current", "available", "rolled-back", "broken"].includes(ph) && u.status.message && Date.now() - started > 5000) {
          busy(go, false);
          return showError(err, u.status.message);
        }
        progress.replaceChildren(h("div.row", h("span.spin"), h("span.muted", steps[ph] || "Working…")));
      } catch { progress.replaceChildren(h("div.row", h("span.spin"), h("span.muted", "Restarting with the new version…"))); }
      if (Date.now() - started < 15 * 60 * 1000) setTimeout(poll, 2000);
      else { busy(go, false); showError(err, "The update is taking much longer than it should. Restart the computer and try again."); }
    };
    poll();
  });
  return box;
}

function updateNeeded(need, have) {
  const a = String(need).split(".").map(Number), b = String(have).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// ---- 6. done ---------------------------------------------------------------------------------------------------------

/** After a restore: the computer the backup came from has to stop answering the server's name. The new one told it
 * (over the home network) right after taking the name over; this says what happened and what's left to do. */
function oldComputerCard() {
  const rf = status && status.restoredFrom;
  if (!rf) return null;
  const told = rf.toldOld || {};
  const down = Object.keys(told).filter((ip) => told[ip] === "stood down");
  const silent = Object.keys(told).filter((ip) => told[ip] !== "stood down");
  const publicName = publicMode(status.mode);
  return h("div.card.stack",
    h("h2", "Switch off the old computer"),
    down.length
      ? h("p", `The old computer (${down.join(", ")}) got the message: chat and calls stopped there${publicName ? ", and it let go of your router's ports" : ""}. Switch it off whenever you like; its copy of the server stays on its disk until then.`)
      : h("p", silent.length
        ? `The old computer didn't answer at its home address (${silent.join(", ")}). If it's still on, switch it off now${publicName ? ": until it learns about the move (within ten minutes) it can still answer your server's name" : ": two servers with the same name on one network confuse phones and computers"}.`
        : `If the computer this backup came from is still on, switch it off now${publicName ? ": until it learns about the move (within ten minutes) it can still answer your server's name" : ": two servers with the same name on one network confuse phones and computers"}.`),
    h("p.small.muted", "Anything written on the old computer after this backup was made isn't here."));
}

function viewDone(lost) {
  const sn = (status && status.serverName) || `${answers.name}.local`;
  const ip = addresses[0];
  // The certificate link uses the address: the server is renaming itself to <name>.local right now.
  const certHref = ip ? `http://${ip}/admin/ca.crt` : "/admin/ca.crt";
  const trustState = h("div.row", h("span.spin"), h("span.muted", "Waiting for this device to trust the server…"));
  const trustBody = h("div.stack",
    h("p.muted", "A home server makes its own security certificate. Each phone or computer that uses it trusts that certificate once — that's what keeps your chats private on your network."),
    h("div.row.wrap", h("a.btn.cta", { href: certHref, download: `tinhat-${sn.replace(/\./g, "-")}.crt` }, "Download certificate")),
    trustInstructions(`Tin Hat server ${sn}`),
    h("div.note.small", `If your browser restarts after you trust the certificate, come back to http://${sn}${ip ? ` (or http://${ip})` : ""} — the next steps are there too.`));
  const trustCard = h("div.card.stack", h("h2", "Trust your server on this device"), trustBody, trustState);
  const openApp = gatedOpen(`https://${sn}/`, "Open Tin Hat");
  watchTrust(sn, (ok) => {
    trustCard.classList.toggle("ok", ok);
    trustBody.classList.toggle("hidden", ok);
    openApp.setTrusted(ok);
    trustState.replaceChildren(ok ? h("span.chip.good", h("span.dot"), "This device trusts your server")
      : h("span.spin"), ok ? "" : h("span.muted", "Waiting for this device to trust the server… (if it doesn't turn green, restart your browser)"));
  });
  const admin = answers.admin.username ? `@${answers.admin.username}:${sn}` : "your admin account";
  const card = h("div.stack-lg",
    h("div.card.hero",
      h("div.badge", { html: ICON.bigcheck }),
      h("h1", "Your server is ready"),
      h("p.lede", `${sn} is up and running${lost ? " (it just renamed itself, so this page lost touch with it — that's expected)" : ""}.`)),
    h("div.numbered",
      oldComputerCard(),
      trustCard,
      h("div.card.stack",
        h("h2", "Open Tin Hat"),
        signInLine(admin),
        openApp.el),
      h("div.card.stack",
        h("h2", "Invite your people"),
        h("p", "Your group's Tin Hat is at ", h("b.mono", `https://${sn}`), " on your home network: anyone there opens it in a browser, on a computer or a phone, with nothing to install, or uses the Tin Hat app. Tell your friends."),
        h("p.muted", "The dashboard makes invite codes. Each friend opens the server's address on your network, trusts it once, and creates an account with their code."),
        h("div.row.wrap", h("a.btn.ghost", { href: `https://${sn}/admin/` }, "Open the dashboard"), h("span.small.muted.mono", `https://${sn}/admin`)))),
    h("p.small.muted", ip ? `If ${sn} doesn't open on a device, use the address ${ip} for the certificate, and check the device is on the same network.` : ""));
  show(null, INFO.done, card);
}

// ---- 6b. done, from anywhere: a real certificate, so no trust step; what the outside check found ---------------

// assembly-038: a setup driven from http://<address>/ (how a VPS owner starts) ends on the server's own https address.
// Port 80 keeps answering only the read-only progress (GET /admin/setup/status) for such a browser; once the server is
// ready this page tries https://<name>/ and moves there (the dashboard) when it answers, else it says where to go.
// The target is ONLY the server's own name from its status answer (launch-gate's condition), never the page's address,
// a query string or what was typed into the form.
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Only the cut-down answer port 80 gives an outside address moves the page (it never carries "unlocked", every other
// answer does): a setup done on the home network over http keeps its last page and the outside check's results.
const outsideAnswer = (st) => !!st && typeof st === "object" && !("unlocked" in st);
function hopToHttps() {
  const sn = status && status.serverName;
  // over plain http only the cut-down answer moves the page (a home setup keeps its last page); the setup page's own
  // https://<address>/ (P2: a VPS owner's private page) always moves to the server's name
  const plain = location.protocol === "http:" && outsideAnswer(status);
  // ... except right after a restore: its finish page offers "Set a new admin password", which needs this page's setup
  // session (the cookie doesn't go to the name): the card links there, it doesn't move by itself (Astra on 01b6fc4)
  const own = location.protocol === "https:" && !HOST_RE.test(location.hostname);
  const stay = own && !!(status && status.restoredFrom);
  if (!(plain || own) || typeof sn !== "string" || !HOST_RE.test(sn) || location.hostname === sn) return null;
  const go = `https://${sn}/admin/`;
  const card = h("div.card.stack-sm",
    h("h2", "Your server is ready at ", h("span.mono", `https://${sn}/`)),
    h("p.muted", plain ? "This page talked to the server over plain http while it set itself up. From now on use its https address:"
      : "This page used the setup's own certificate while the server set itself up. From now on use its real https address:"),
    h("div.row.wrap", h("a.btn.cta", { href: go }, "Open it"), h("span.small.muted.mono", go)));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  // no-cors: the answer can't be read from here, but a reply at all means the name and certificate work from this browser
  fetch(`https://${sn}/admin/setup/status`, { mode: "no-cors", cache: "no-store", signal: ctl.signal })
    .then(() => { clearTimeout(t); if (!stay) location.href = go; })
    .catch(() => clearTimeout(t));
  return card;
}

// Over plain http from outside the home the status answer carries no mode (OUTSIDE_STATUS_KEYS): a server name that isn't
// <name>.local is a public one, as is the mode this page chose.
const isPublic = (st) => publicMode(st.mode) || (!st.mode && (publicMode(answers.mode) || (typeof st.serverName === "string" && !/\.local$/.test(st.serverName))));

async function viewDoneAnywhere() {
  const sn = (status && status.serverName) || serverName();
  const hop = hopToHttps();
  const own = ((status && status.mode) || answers.mode) === "domain";
  const short = own ? sn : sn.split(".")[0]; // what friends type in the app: a tinhat.me name's first part, or the whole domain
  let net = (status && status.network) || null;
  // The finish says what's true: green only once friends outside can reach it (or before the results are in).
  const hero = h("div.card.hero");
  const viaProxy = () => !!((net && net.proxy) || (answers.domain && answers.domain.provider === "proxy"));
  const setHero = (level) => {
    const good = !level || level === "good";
    const at = viaProxy() ? `It's at ${sn}, through your reverse proxy.` : `It's at ${sn} with a real certificate.`;
    hero.replaceChildren(
      h(`div.badge${good ? "" : ".warn"}`, { html: good ? ICON.bigcheck : ICON.bigwarn }),
      h("h1", good ? "Your server is ready" : "Your server is set up"),
      h("p.lede", good ? `${at} Friends ${own ? "" : "just "}type “${short}”.`
        : level === "warn" ? `${at} Friends outside can chat; one router setting is left before their calls connect (below).`
          : viaProxy() ? `It's ready for your reverse proxy at ${sn}. One thing is left: send the domain to this server (below).`
            : `${at} One thing is left: friends outside can't reach it yet (below).`));
  };
  setHero(net && net.summary ? net.summary.level : status && status.reach && !status.reach.ok ? "bad" : null);
  const reachCard = h("div.card.stack", h("h2", "Friends outside"), h("div.row", h("span.spin"), h("span.muted", "Loading the check's results…")));
  const relayErr = h("div.error.hidden");
  const relayBtn = status && status.setupSession ? h("button.btn.cta", { type: "button" }, "Use the Tin Hat relay") : null;
  if (relayBtn) {
    relayBtn.addEventListener("click", async () => {
      busy(relayBtn, true, "Connecting to the relay…");
      relayErr.classList.add("hidden");
      try {
        net = await api("/admin/setup/relay", { json: { use: true } });
        renderReach(net);
      } catch (ex) {
        busy(relayBtn, false);
        relayErr.textContent = ex.message;
        relayErr.classList.remove("hidden");
      }
    });
  }
  // Friends can't get in and the router can't help (carrier NAT, or ports nobody can open): the relay instead.
  const relayOffer = (n) => {
    const r = n.relay || {};
    if (r.on || !relayBtn || !r.available) return null; // only for tinhat.me names, while a relay is there
    const cgnat = n.ports && n.ports.kind === "cgnat";
    if (!cgnat && n.summary.level === "good") return null;
    return h("div.stack-sm",
      h("div.k", cgnat ? "Use the Tin Hat relay instead" : "Can't change your router's settings?"),
      h("p.muted", (cgnat ? "No router setting can open your home to friends outside. " : "")
        + "The Tin Hat relay can carry their traffic: your server keeps a connection open to it, and keeps its own certificate, so the relay passes everything on without being able to read it."),
      h("div.row.wrap", relayBtn), relayErr);
  };
  const checkErr = h("div.error.hidden");
  const checkBtn = status && status.setupSession ? h("button.btn.ghost", { type: "button" }, "Check again") : null;
  let numbered = null; // the numbered cards below; behind your own reverse proxy, its settings come first
  let proxyEl = null;
  const renderReach = (n) => {
    const sm = n && n.summary;
    if (!sm) return;
    if (n.proxy && !proxyEl) proxyEl = proxyCard(n.proxy);
    if (proxyEl && numbered && !numbered.contains(proxyEl)) numbered.prepend(proxyEl);
    setHero(sm.level);
    const chip = h(`span.chip.${sm.level === "good" ? "good" : sm.level === "warn" ? "warn" : "bad"}`, h("span.dot"),
      sm.level === "good" ? "Reachable" : sm.level === "warn" ? "Partly reachable" : "Not reachable yet");
    const viaRelay = n.relay && n.relay.on;
    reachCard.replaceChildren(...[h("h2", "Friends outside"),
      h("div.row.wrap", chip, viaRelay ? h("span.chip.accent", `Through the Tin Hat relay (${n.relay.relayAddress})`) : null),
      h("p", sm.headline), ...(sm.lines || []).map((l) => h("p.muted", l)),
      relayOffer(n),
      (sm.fix || []).length ? h("div.stack-sm", h("div.k", "In your router's settings (often its phone app):"), h("ul.fix", (sm.fix || []).map((f) => h("li", f)))) : null,
      sm.level === "good" || viaRelay ? null : h("p.small.muted", "The server keeps asking your router every few minutes, and checks from outside again by itself once the ports open; this page updates when it does. ",
        h("a", { href: "https://tinhat.dev/server/anywhere/#ports", target: "_blank", rel: "noopener" }, "Router how-tos"), "."),
      checkBtn ? h("div.row.wrap", checkBtn, n.reach && n.reach.at ? h("span.small.muted", `Last checked ${ago(n.reach.at * 1000)}`) : null) : null,
      checkErr,
      h("p.small.muted", "The dashboard's Network tab always has the latest result.")].filter(Boolean));
  };
  if (checkBtn) {
    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = "Checking… (calls pause for a few seconds)";
      checkErr.classList.add("hidden");
      try {
        net = await api("/admin/setup/network/check", { json: {} });
        renderReach(net);
        homeReach(sn, homeCheck);  // and this device again
      } catch (ex) {
        checkErr.textContent = ex.message;
        checkErr.classList.remove("hidden");
      } finally {
        checkBtn.disabled = false;
        checkBtn.textContent = "Check again";
      }
    });
  }
  if (net) renderReach(net);
  // While friends can't reach it yet, follow the server's own retries: the page turns green by itself once they can.
  let wasGood = !!(net && net.summary && net.summary.level === "good");
  const follow = status && status.setupSession ? setInterval(async () => {
    try {
      const st = await api("/admin/setup/status");
      if (!st.network) return;
      net = st.network;
      renderReach(net);
      const good = net.summary && net.summary.level === "good";
      if (good && !wasGood) homeReach(sn, homeCheck);
      wasGood = good;
      if (good) clearInterval(follow);
    } catch { /* keep the last result on screen */ }
  }, 20000) : 0;
  // Right after setup or a restore the ports or the relay tunnel can take a minute or two: check from outside again by
  // itself (after 30 s, 1, 2 and 4 minutes) instead of leaving "Check again" to the owner.
  if (checkBtn && !wasGood) {
    let n = 0;
    const again = async () => {
      if (wasGood || n >= 4) return;
      n += 1;
      try {
        net = await api("/admin/setup/network/check", { json: {} });
        renderReach(net);
        const good = net.summary && net.summary.level === "good";
        if (good && !wasGood) homeReach(sn, homeCheck);
        wasGood = good;
      } catch { /* the Check again button is still there */ }
      if (!wasGood) setTimeout(again, 30000 * 2 ** n);
    };
    setTimeout(again, 30000);
  }
  const homeCheck = h("div.row", h("span.spin"), h("span.muted", `Checking this device can open ${sn}…`));
  const admin = answers.admin.username ? `@${answers.admin.username}:${sn}` : "your admin account";
  numbered = h("div.numbered",
    proxyEl,
    oldComputerCard(),
    h("div.card.stack",
      h("h2", "Open Tin Hat"),
      signInLine(admin),
      h("div.row.wrap", h("a.btn.cta", { href: `https://${sn}/` }, "Open Tin Hat"), h("span.small.muted.mono", `https://${sn}`)),
      homeCheck),
    reachCard,
    h("div.card.stack",
      h("h2", "Invite your people"),
      h("p", "Your group's Tin Hat is at ", h("b.mono", `https://${sn}`), `: anyone opens it in a browser, on a computer or a phone, with nothing to install (typing just ${sn} also works in browsers that try https first), or uses the Tin Hat app with “${short}” as the server. Tell your friends.`),
      h("p.muted", `The dashboard makes invite links. Friends open the link, or type “${short}” in the Tin Hat app, and create an account with the code.`),
      h("div.row.wrap", h("a.btn.ghost", { href: `https://${sn}/admin/` }, "Open the dashboard"), h("span.small.muted.mono", `https://${sn}/admin`))));
  const card = h("div.stack-lg", ...(hop ? [hop] : []), hero, numbered);
  show(null, net && net.relay && net.relay.on ? INFO.doneRelay : viaProxy() ? INFO.doneProxy : own ? INFO.doneDomain : INFO.doneAnywhere, card);
  if (HOST_RE.test(sn)) homeReach(sn, homeCheck);  // (assembly-038) only a real host name is ever asked
  if (!net) {
    try {
      const st = await api("/admin/setup/status");
      if (st.network) renderReach(st.network);
    } catch { /* the page still works without it */ }
  }
}

// ---- boot ----------------------------------------------------------------------------------------------------------

// The installer and the tray icon on the server's own Windows PC open this page with the code after "#code=": a fragment
// never leaves the browser, so the code isn't sent anywhere or kept in a log. It's taken off the address right away.
const handedCode = (() => {
  const m = /(?:^#|&)code=(\d{4})-?(\d{4})(?:&|$)/.exec(location.hash);
  if (location.hash.includes("code=")) history.replaceState(null, "", location.pathname + location.search);
  return m ? `${m[1]}-${m[2]}` : "";
})();

async function boot() {
  try {
    status = await api("/admin/setup/status");
  } catch (ex) {
    return app.replaceChildren(h("div.card.stack", h("h2", "Can't reach the server"), h("div.error", ex.message), h("button.btn.ghost", { onclick: boot }, "Try again")));
  }
  $("#meta").textContent = status.version ? `version ${status.version}` : "";
  if (status.addresses) addresses = status.addresses;
  if (status.zone) zone = status.zone;
  if (status.mode) answers.mode = status.mode;
  if (status.serverName && !answers.name) answers.name = status.serverName.replace(/\.local$/, "").replace(new RegExp(`\\.${zone.replace(".", "\\.")}$`), "");
  if (status.phase === "ready") return isPublic(status) ? viewDoneAnywhere() : viewDone(false);
  if (!status.unlocked) return viewUnlock();
  if (status.phase === "installing" || status.phase === "failed") return viewProgress();
  return viewStart();
}

boot();
