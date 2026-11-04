// greg-admin: the owner's private controls. Only the owner (admin key or allowlisted login) gets in.
// Visitors can watch and react; only this function can grant wishes, add things or pause Greg.
import { cors, db, json, who } from "./auth.ts";

const FN = Deno.env.get("SUPABASE_URL") + "/functions/v1";
const REACT = [
  "For me? Tremendous. The best gift a frog has ever received. Nobody gives gifts like my owner.",
  "Wow. Beautiful. I'm putting it right where everyone can see it. Because I'm generous.",
  "Finally! I asked and the universe delivered. Well, my owner. Same thing.",
];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

async function claudeReact(what: string) {
  const key = Deno.env.get("ANTHROPIC_API_KEY"); if (!key) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: Deno.env.get("GREG_MODEL") ?? "claude-haiku-5-5", max_tokens: 120, system: "You are Greg, a boastful, lovable golf-obsessed cartoon frog. One or two short sentences. No real people, no politics, no long dashes.", messages: [{ role: "user", content: `Your owner just gave you: ${what}. React.` }] }), signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null; const j = await r.json(); return (j.content ?? []).map((c: any) => c.text || "").join("").replace(/[–—]/g, ",").trim().slice(0, 240) || null;
  } catch { return null; }
}

async function say(text: string, kind = "reaction") {
  await db.from("greg_state").update({ speech: text, updated_at: new Date().toISOString() }).eq("id", 1);
  await db.from("greg_diary").insert({ kind, text });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if ((await who(req)) !== "owner") return json({ error: "owner only" }, 401);
  const b = await req.json().catch(() => ({}));
  const now = new Date().toISOString();
  switch (b.op) {
    case "whoami": return json({ owner: true });
    case "overview": {
      const [state, settings, wallet, wishes, items, questions, posts, requests, tools] = await Promise.all([
        db.from("greg_state").select("*").eq("id", 1).single(),
        db.from("greg_settings").select("*").eq("id", 1).single(),
        db.from("greg_wallet").select("*").eq("id", 1).single(),
        db.from("greg_wishes").select("*").order("created_at", { ascending: false }).limit(50),
        db.from("greg_items").select("*").order("created_at", { ascending: false }).limit(50),
        db.from("greg_questions").select("id,created_at,question,kind,status,sort,answer,read_at").order("created_at", { ascending: false }).limit(100),
        db.from("greg_posts").select("*").order("created_at", { ascending: false }).limit(40),
        db.from("greg_wallet_requests").select("*").order("created_at", { ascending: false }).limit(40),
        db.from("greg_tools").select("*"),
      ]);
      const health = { llm: !!Deno.env.get("ANTHROPIC_API_KEY"), x: !!(Deno.env.get("GREG_X_API_KEY") && Deno.env.get("GREG_X_ACCESS_TOKEN")), walletKek: !!Deno.env.get("GREG_WALLET_KEK") };
      return json({ state: state.data, settings: settings.data, wallet: wallet.data, wishes: wishes.data, items: items.data, questions: questions.data, posts: posts.data, requests: requests.data, tools: tools.data, health });
    }
    case "pause": await db.from("greg_state").update({ paused: !!b.paused, status_line: b.paused ? "Greg is taking a break" : "Greg is back", updated_at: now }).eq("id", 1); return json({ ok: true });
    case "grant_wish": {
      const { data: w } = await db.from("greg_wishes").select("*").eq("id", b.id).single();
      if (!w || w.status !== "waiting") return json({ error: "not waiting" }, 400);
      const { data: item } = await db.from("greg_items").insert({ name: b.name || w.title, kind: b.kind || "item", emoji: b.emoji || "🎁", note: b.note || w.why, wish_id: w.id, x: b.x ?? null, z: b.z ?? null }).select().single();
      const reaction = (await claudeReact(w.title)) || pick(REACT);
      await db.from("greg_wishes").update({ status: "granted", granted_at: now, item_id: item?.id, reaction }).eq("id", w.id);
      await say(reaction);
      return json({ ok: true, item, reaction });
    }
    case "decline_wish": await db.from("greg_wishes").update({ status: "declined" }).eq("id", b.id); await say("Not today? Fine. I'll ask again tomorrow. And the day after. I'm very persistent, it's one of my best qualities.", "say"); return json({ ok: true });
    case "add_wish": { const { data } = await db.from("greg_wishes").insert({ title: String(b.title).slice(0, 80), why: b.why ? String(b.why).slice(0, 200) : null }).select().single(); return json({ ok: true, wish: data }); }
    case "add_item": {
      if (!b.name) return json({ error: "name required" }, 400);
      const { data: item } = await db.from("greg_items").insert({ name: String(b.name).slice(0, 40), kind: b.kind === "place" ? "place" : "item", emoji: (b.emoji || "⭐").slice(0, 8), note: b.note ? String(b.note).slice(0, 200) : null, x: b.x ?? null, z: b.z ?? null }).select().single();
      const reaction = (await claudeReact(`a new ${b.kind === "place" ? "place on your island" : "item"}: ${b.name}`)) || pick(REACT);
      await say(reaction);
      return json({ ok: true, item, reaction });
    }
    case "remove_item": await db.from("greg_items").delete().eq("id", b.id); return json({ ok: true });
    case "settings": {
      const allowed = ["x_enabled", "x_mode", "x_handle", "llm_enabled", "browse_enabled", "daily_llm_calls_cap"];
      const patch: any = { updated_at: now }; for (const k of allowed) if (k in b) patch[k] = b[k];
      await db.from("greg_settings").update(patch).eq("id", 1); return json({ ok: true });
    }
    case "post": {
      if (b.action === "approve") await db.from("greg_posts").update({ status: "approved" }).eq("id", b.id);
      else if (b.action === "reject") await db.from("greg_posts").update({ status: "rejected" }).eq("id", b.id);
      else if (b.action === "edit") await db.from("greg_posts").update({ text: String(b.text).slice(0, 280) }).eq("id", b.id);
      return json({ ok: true });
    }
    case "question": await db.from("greg_questions").update({ status: b.status === "skipped" ? "skipped" : "new", sort: b.status === "skipped" ? "spam" : null }).eq("id", b.id); return json({ ok: true });
    case "wallet_settings": {
      const allowed = ["enabled", "kill_switch", "daily_cap_sol", "per_tx_cap_sol", "approval_threshold_sol", "allowed_programs", "allowed_marketplaces"];
      const patch: any = { updated_at: now }; for (const k of allowed) if (k in b) patch[k] = b[k];
      if (patch.daily_cap_sol != null && (patch.daily_cap_sol < 0 || patch.daily_cap_sol > 5)) return json({ error: "daily cap must be 0 to 5 SOL" }, 400);
      if (patch.per_tx_cap_sol != null && (patch.per_tx_cap_sol < 0 || patch.per_tx_cap_sol > 2)) return json({ error: "per purchase cap must be 0 to 2 SOL" }, 400);
      await db.from("greg_wallet").update(patch).eq("id", 1);
      await db.from("greg_chain_log").insert({ kind: "settings", note: `Owner changed wallet settings: ${Object.keys(patch).filter((k) => k !== "updated_at").join(", ")}` });
      return json({ ok: true });
    }
    case "tick": case "wallet": {
      // forward to greg-tick / greg-wallet with the owner's key
      const target = b.op === "tick" ? "greg-tick" : "greg-wallet";
      const r = await fetch(`${FN}/${target}`, { method: "POST", headers: { "content-type": "application/json", "x-greg-key": req.headers.get("x-greg-key") || "", authorization: req.headers.get("authorization") || "" }, body: JSON.stringify(b.payload || {}) });
      return json(await r.json().catch(() => ({ error: "bad response" })), r.status);
    }
  }
  return json({ error: "unknown op" }, 400);
});
