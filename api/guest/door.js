// door.js — the guest room's door page (/call/, api/guest/index.html). A file of its own, not an inline script, so the
// page runs under the web app's Content-Security-Policy (script-src 'self'; security review 2026-10-26, M3).
const qs = new URLSearchParams(location.search);
const g = qs.get("g") || "";
const $ = (id) => document.getElementById(id);
const show = (id) => { for (const s of ["ask", "waiting", "done"]) $(s).hidden = s !== id; };
const finish = (title, text, again = false) => {
  $("doneTitle").textContent = title;
  $("doneText").textContent = text;
  $("again").hidden = !again;
  show("done");
};
const closed = () => finish("This guest link isn't open", "Ask whoever sent it for a new one.");
try { const saved = localStorage.getItem("tinhat-guest-name"); if (saved) $("name").value = saved; } catch { /* private window */ }

async function door() {
  if (!/^[A-Za-z0-9_-]{24}$/.test(g)) return closed();
  try {
    const r = await fetch(`/api/guest/door?g=${encodeURIComponent(g)}`, { cache: "no-store" });
    if (r.status === 404) return closed();
    const d = await r.json();
    document.title = `Guests · ${d.server}`;
    $("title").textContent = `Guests · ${d.server}`;
    if (!d.open) return finish("The guest room is closed right now", "Ask whoever sent the link to open it, then load this page again.");
    $("name").focus();
  } catch {
    $("err").textContent = "Couldn't reach the server. Check your connection and reload.";
  }
}

let ticket = "", every = 2, timer = 0;
async function poll() {
  try {
    const r = await fetch(`/api/guest/ticket?t=${encodeURIComponent(ticket)}`, { cache: "no-store" });
    const d = await r.json().catch(() => ({ state: "expired" }));
    if (d.state === "waiting") { timer = setTimeout(poll, every * 1000); return; }
    if (d.state === "in" && d.session && typeof d.session.web === "string" && d.session.web.startsWith(`${location.origin}/`)) {
      finish("You're in", "Opening Tin Hat…");
      location.replace(d.session.web);
      return;
    }
    if (d.state === "turned-away") return finish("Nobody let you in this time", "You can knock again later.", true);
    if (d.state === "closed") return closed();
    return finish("The knock ran out", "Nobody answered in time.", true);
  } catch {
    timer = setTimeout(poll, Math.min(10, every * 2) * 1000);  // a blip: keep waiting
  }
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("name").value.trim();
  if (!name) return;
  try { localStorage.setItem("tinhat-guest-name", name); } catch { /* fine */ }
  $("knock").disabled = true;
  $("err").textContent = "";
  try {
    const r = await fetch("/api/guest/knock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ g, name }) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 410) return closed();
    if (!r.ok) { $("err").textContent = d.error || "That didn't work. Try again in a moment."; return; }
    ticket = d.ticket;
    every = Math.max(1, Number(d.every) || 2);
    show("waiting");
    timer = setTimeout(poll, every * 1000);
  } catch {
    $("err").textContent = "Couldn't reach the server. Check your connection and try again.";
  } finally {
    $("knock").disabled = false;
  }
});
$("again").addEventListener("click", () => { clearTimeout(timer); show("ask"); door(); });
door();
