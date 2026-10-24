// welcome.js — what a new device sees at http://<server>.local once the server is set up:
// trust the server once, then open Tin Hat (and create an account with an invite code).
"use strict";

/** Behind carrier NAT with the Tin Hat relay off, the server's name points at an address nothing reaches, so its owner
 * can't even open the dashboard at home. This page (home network only) turns the relay back on with an admin's
 * sign-in. */
function relayHome(st) {
  const r = st.relay || {};
  if (r.on || !(r.cgnat || (st.reach && st.reach.at && !st.reach.ok))) return null;
  const err = h("div.error.hidden", { role: "alert" });
  const user = h("input", { type: "text", autocomplete: "username", autocapitalize: "none", spellcheck: "false" });
  const pw = h("input", { type: "password", autocomplete: "current-password" });
  const go = h("button.btn.cta", { type: "submit" }, "Turn on the Tin Hat relay");
  const form = h("form.stack-sm", {
    onsubmit: async (e) => {
      e.preventDefault();
      go.disabled = true;
      go.replaceChildren(h("span.spin"), "Connecting to the relay…");
      err.classList.add("hidden");
      try {
        const n = await api("/admin/home/relay", { json: { username: user.value.trim(), password: pw.value } });
        form.replaceChildren(h("span.chip.good", h("span.dot"), "Reachable through the Tin Hat relay"),
          h("p.muted", (n.summary && n.summary.headline) || "Friends outside your home can reach your server again."));
      } catch (ex) {
        go.disabled = false;
        go.textContent = "Turn on the Tin Hat relay";
        err.textContent = ex.message;
        err.classList.remove("hidden");
        pw.select();
      }
    },
  }, h("label.field", h("span", "Admin username"), user), h("label.field", h("span", "Password"), pw), err, h("div.row.wrap", go));
  return h("div.card.stack",
    h("h2", "Friends outside can't reach this server"),
    h("p.muted", r.cgnat ? "This home's internet provider doesn't allow incoming connections, so friends outside, and this server's own address, only work through the Tin Hat relay. It's off."
      : "Friends outside this home can't reach this server. The Tin Hat relay can carry their traffic without opening any ports on the router."),
    h("p.small.muted", "Running this server? Sign in with its admin account to turn the relay on. The relay passes traffic on without being able to read it."),
    form);
}

async function main() {
  const app = $("#app");
  let st;
  try {
    st = await api("/admin/setup/status");
  } catch (ex) {
    app.replaceChildren(h("div.card.stack", h("h2", "Can't reach the server"), h("div.error", ex.message)));
    return;
  }
  if (st.phase !== "ready") {
    location.replace("/");
    return;
  }
  const sn = st.serverName;
  $("#meta").textContent = sn;
  if (st.moved) {  // restored on another computer: this one stood down
    app.replaceChildren(h("div.card.stack",
      h("h1", `${sn} moved to another computer`),
      h("p.lede", "It was restored there from a backup, so chat and calls stopped on this computer and the other one has the name now."),
      h("div.row.wrap", h("a.btn.cta", { href: `https://${sn}/` }, "Open Tin Hat"), h("span.small.muted.mono", `https://${sn}`)),
      h("p.small.muted", "Running this server? You can switch this computer off; its copy stays on its disk.")));
    return;
  }
  if (publicMode(st.mode)) {  // a real certificate: no trust step, just the address
    const short = typedName(sn, st.zone);
    const here = h("div.row", h("span.spin"), h("span.muted", `Checking this device can open ${sn}…`));
    const relayCard = relayHome(st);
    const outside = st.reach && st.reach.at && !relayCard ? h("p.small.muted", st.reach.ok
      ? `Friends outside this home can reach it (checked ${ago(st.reach.at * 1000)}).`
      : `Friends outside this home can't reach it yet (checked ${ago(st.reach.at * 1000)}). The server keeps trying by itself; its owner can see why in the dashboard's Network tab, or on the setup page right after setup.`) : null;
    app.replaceChildren(h("div.stack-lg",
      h("div.stack-sm", h("h1", `Welcome to ${st.mode === "domain" ? sn : short}`), h("p.lede", "This is a Tin Hat server — private chat, voice and video for the people on it.")),
      h("div.card.stack",
        h("h2", "Open Tin Hat"),
        h("p.muted", st.mode === "domain" ? `The server lives at ${sn}. In the Tin Hat app, type “${sn}”.` : `The server lives at ${sn}. In the Tin Hat app, just type “${short}”.`),
        h("p.muted", "New here? Choose “Create an account” and enter the invite code you were given. Already have an account? Just sign in."),
        h("div.row.wrap", h("a.btn.cta", { href: `https://${sn}/` }, "Open Tin Hat"), h("span.small.muted.mono", `https://${sn}`)),
        here, outside),
      relayCard,
      h("p.small.muted", "Running this server? ", h("a", { href: `https://${sn}/admin/` }, "Open the dashboard"), " · ",
        h("a", { href: "#", onclick: (e) => { e.preventDefault(); recoverHere(app, main); } }, "Forgot the admin password?"))));
    homeReach(sn, here);
    return;
  }
  const openApp = gatedOpen(`https://${sn}/`, "Open Tin Hat");
  const trustState = h("div.row", h("span.spin"), h("span.muted", "Checking whether this device trusts the server…"));
  const trustBody = h("div.stack",
    h("p.muted", "This server makes its own security certificate. Trust it once on this device and your chats stay private on the network."),
    h("div.row.wrap", h("a.btn.cta", { href: "/admin/ca.crt", download: `tinhat-${sn.replace(/\./g, "-")}.crt` }, "Download certificate")),
    trustInstructions(`Tin Hat server ${sn}`),
    h("div.note.small", `If your browser restarts after you trust the certificate, come back to http://${sn} — this page will be here.`));
  const trustCard = h("div.card.stack", h("h2", "Trust this server"), trustBody, trustState);
  app.replaceChildren(h("div.stack-lg",
    h("div.stack-sm", h("h1", `Welcome to ${sn}`), h("p.lede", "This is a Tin Hat server — private chat, voice and video for the people on it. Two quick steps get this device ready.")),
    h("div.numbered",
      trustCard,
      h("div.card.stack",
        h("h2", "Open Tin Hat"),
        h("p.muted", "New here? Choose “Create an account” and enter the invite code you were given. Already have an account? Just sign in."),
        openApp.el)),
    h("p.small.muted", "Running this server? ", h("a", { href: `https://${sn}/admin/` }, "Open the dashboard"), " · ",
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); recoverHere(app, main); } }, "Forgot the admin password?"))));
  watchTrust(sn, (ok) => {
    trustCard.classList.toggle("ok", ok);
    trustBody.classList.toggle("hidden", ok);
    openApp.setTrusted(ok);
    trustState.replaceChildren(ok ? h("span.chip.good", h("span.dot"), "This device trusts the server — you're all set")
      : h("span.spin"), ok ? "" : h("span.muted", "Not trusted yet. After you install the certificate this turns green (restart the browser if it doesn't)."));
  });
}

function recoverHere(app, back) {
  app.replaceChildren(recoverCard((mxid) => {
    app.replaceChildren(h("div.card.stack", h("h2", "Password changed"), h("p.muted", `${mxid} can sign in with the new password now.`),
      h("button.btn.ghost", { type: "button", onclick: back }, "Done")));
  }, back));
}

main();
