// Global island chat. Messages are stored only through the greg-chat edge function (filters, rate limits, bans);
// everyone gets new ones live through Realtime and newcomers see the last 100. T or Enter to type, Esc to close.
import { sb } from "./data.js";
import { FN, esc } from "./config.js";

export function startChat({ input, save, flies, toast }) {
  const coarse = matchMedia("(pointer: coarse)").matches;
  const box = document.createElement("section"); box.className = "gchat" + (coarse ? " closed" : ""); box.setAttribute("aria-label", "Island chat");
  box.innerHTML = `<header><b>💬 Island chat</b><button class="gx" aria-label="Close chat">×</button></header><div class="log" role="log" aria-live="polite"></div><form><input maxlength="200" placeholder="Press T or Enter to chat" autocomplete="off" aria-label="Chat message"><button>Send</button></form>`;
  document.body.appendChild(box);
  for (const ev of ["pointerdown", "mousedown", "click", "wheel", "touchstart"]) box.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  const btn = document.createElement("button"); btn.className = "gchatbtn"; btn.textContent = "💬"; btn.setAttribute("aria-label", "Open chat"); document.body.appendChild(btn);
  const log = box.querySelector(".log"), form = box.querySelector("form"), inp = form.querySelector("input");
  const muted = new Set(save.get("muted", []));
  const seen = new Set();
  function add(m, quiet) {
    if (!m || seen.has(m.id) || muted.has(m.fly_id)) return; seen.add(m.id);
    const row = document.createElement("div"); row.className = "msg" + (m.from_greg ? " greg" : "");
    const col = m.from_greg ? "#3ea24a" : `hsl(${m.hue || 0} 55% 38%)`;
    row.innerHTML = `<b style="color:${col}">${esc(m.from_greg ? "Greg" : m.name)}</b> <span>${esc(m.text)}</span>${m.from_greg || m.fly_id === flies.sid ? "" : `<i class="act"><button data-a="mute" title="Mute this fly">🔇</button><button data-a="report" title="Report">⚑</button></i>`}`;
    row.querySelector("[data-a=mute]")?.addEventListener("click", () => { muted.add(m.fly_id); save.set("muted", [...muted]); [...log.children].forEach((r) => r.dataset.f === m.fly_id && r.remove()); toast && toast(m.name + " muted"); });
    row.querySelector("[data-a=report]")?.addEventListener("click", async (e) => { e.target.disabled = true; await call({ op: "report", id: m.id }); toast && toast("Reported. Thanks for keeping the island nice."); });
    row.dataset.f = m.fly_id; log.appendChild(row); while (log.children.length > 100) log.firstChild.remove(); log.scrollTop = log.scrollHeight;
    if (!quiet) { flies.say && flies.say(m.fly_id, m.text); if (box.classList.contains("closed")) btn.classList.add("ping"); }
  }
  const call = (body) => fetch(FN + "/greg-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => ({ ok: false, error: "network" }));
  // history + live
  sb.from("greg_chat").select("id,created_at,fly_id,name,hue,text,from_greg").order("id", { ascending: false }).limit(100).then(({ data }) => { (data || []).reverse().forEach((m) => add(m, true)); });
  sb.channel("greg-chat").on("postgres_changes", { event: "INSERT", schema: "public", table: "greg_chat" }, ({ new: m }) => !m.hidden && add(m)).subscribe();
  let lastSend = 0;
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); const text = inp.value.trim(); if (!text) { inp.blur(); return; }
    if (Date.now() - lastSend < 2000) { toast && toast("One message every 2 seconds"); return; }
    lastSend = Date.now(); const r = await call({ op: "send", fly: flies.sid, name: flies.name(), hue: flies.me.hue, text, room: flies.room() });
    if (r.ok) { inp.value = ""; add(r.msg); } else toast && toast(r.error || "Could not send");
  });
  function open(focus = true) { box.classList.remove("closed"); btn.classList.remove("ping"); if (focus) { input.release(); setTimeout(() => inp.focus(), 30); } }
  function close() { inp.blur(); if (coarse) box.classList.add("closed"); }
  input.on("chat", () => open(true)); input.on("closeChat", close);
  inp.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } e.stopPropagation(); });
  box.querySelector(".gx").onclick = () => { box.classList.add("closed"); inp.blur(); };
  btn.onclick = () => (box.classList.contains("closed") ? open(!coarse) : box.classList.add("closed"));
  return { open, close, add, call };
}
