// api/poll.js
// Vercel cron: daily at 9am UTC
// Edit prompt.md to change extraction behaviour — never touch this file.

import Anthropic from "@anthropic-ai/sdk";
import { buildPrompt } from "./prompt.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Upstash KV ─────────────────────────────────────────────────────────────

async function kvGet(key) {
  const res = await fetch(
    `${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` } }
  );
  const json = await res.json();
  if (!json.result) return null;
  try { return JSON.parse(json.result); } catch { return json.result; }
}

async function kvSet(key, value) {
  const serialized = encodeURIComponent(JSON.stringify(value));
  await fetch(
    `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}/${serialized}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
    }
  );
}

// ── Resend ─────────────────────────────────────────────────────────────────

async function fetchResendEmails() {
  const res = await fetch("https://api.resend.com/emails/receiving?limit=20", {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  });
  const json = await res.json();
  return json.data || [];
}

async function fetchEmailDetails(emailId) {
  const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  });
  return res.json();
}

function extractBody(details) {
  const text = details.text || "";
  const html = details.html || "";
  if (text.length > 200) return text.slice(0, 12000);
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 12000);
}

// ── Claude ─────────────────────────────────────────────────────────────────

async function extractSignals(emailBody, subject, existingData) {
  const existingCos = (existingData.companies || [])
    .map((c) => c.name).slice(0, 30).join(", ") || "none yet";
  const existingThemes = Object.keys(existingData.themes || {}).join(", ") || "none yet";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{
      role: "user",
      content: buildPrompt({ emailBody, subject, existingCos, existingThemes }),
    }],
  });

  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  let depth = 0, start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") { if (depth === 0) start = i; depth++; }
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  console.error("RAW CLAUDE RESPONSE:", raw.slice(0, 1000));
  throw new Error("No valid JSON in Claude response");
}

// ── Merge ──────────────────────────────────────────────────────────────────

function mergeData(existing, parsed, subject) {
  const now = new Date().toISOString().slice(0, 10);

  const issues = [
    {
      date: parsed.issueDate || now,
      title: parsed.issueTitle || subject,
      companyCount: (parsed.companies || []).length,
      themeCount: (parsed.themes || []).length,
      receivedAt: now,
    },
    ...(existing.issues || []),
  ].slice(0, 50);

  const companies = [...(existing.companies || [])];
  for (const c of parsed.companies || []) {
    const idx = companies.findIndex(
      (x) => x.name.toLowerCase() === c.name.toLowerCase()
    );
    if (idx >= 0) {
      const ex = companies[idx];
      ex.mentions = (ex.mentions || 1) + 1;
      ex.lastSeen = now;
      if ((c.funding?.amountUSD || 0) > 0) ex.funding = c.funding;
      if (c.exit?.likelyAcquirer) ex.exit = c.exit;
      if (c.description) ex.description = c.description;
      if (c.category) ex.category = c.category;
      if (c.similarCompanies) ex.similarCompanies = c.similarCompanies;
      for (const t of c.themes || []) {
        if (!ex.themes.includes(t)) ex.themes.push(t);
      }
    } else {
      companies.push({ ...c, mentions: 1, firstSeen: now, lastSeen: now });
    }
  }

  const themes = { ...(existing.themes || {}) };
  for (const t of parsed.themes || []) {
    const key = t.name.toLowerCase();
    if (themes[key]) {
      themes[key].momentum = Math.max(themes[key].momentum, t.momentum);
      themes[key].signalCount = (themes[key].signalCount || 1) + 1;
      themes[key].lastSeen = now;
      themes[key].description = t.description;
    } else {
      themes[key] = { ...t, signalCount: 1, firstSeen: now, lastSeen: now };
    }
  }

  return { companies, themes, issues, lastUpdated: now };
}

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const processedIds = (await kvGet("processed_email_ids")) || [];
    const emails = await fetchResendEmails();
    const newEmails = emails.filter((e) =>
      Array.isArray(processedIds) && !processedIds.includes(e.id)
    );

    if (!newEmails.length) {
      return res.status(200).json({ ok: true, message: "No new emails to process" });
    }

    let existing = (await kvGet("radar_data")) || {};
    const newProcessedIds = Array.isArray(processedIds) ? [...processedIds] : [];
    let processed = 0;

    for (const email of newEmails) {
      try {
        const details = await fetchEmailDetails(email.id);
        const body = extractBody(details);
        if (body.length < 200) {
          console.log(`Skipping ${email.id}: body too short`);
          continue;
        }
        const parsed = await extractSignals(body, details.subject || "This Week in Fintech", existing);
        existing = mergeData(existing, parsed, details.subject || "This Week in Fintech");
        newProcessedIds.push(email.id);
        processed++;
        console.log(`Processed: ${details.subject} — ${(parsed.companies || []).length} companies`);
      } catch (e) {
        console.error(`Failed to process ${email.id}:`, e.message);
      }
    }

    await kvSet("radar_data", existing);
    await kvSet("processed_email_ids", newProcessedIds.slice(-200));

    return res.status(200).json({ ok: true, processed, total: newEmails.length });
  } catch (err) {
    console.error("Poll error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
