// api/poll.js
// Vercel cron: daily at 9am UTC
// Fetches new emails from Resend → extracts signals via Claude → stores in Upstash

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Upstash KV helpers ─────────────────────────────────────────────────────
// Upstash REST: GET /get/:key  →  { result: "json-string" }
//               POST /set/:key/:value  (value URL-encoded in path)

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

// ── Resend helpers ─────────────────────────────────────────────────────────

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

// ── Claude extraction ──────────────────────────────────────────────────────

async function extractSignals(emailBody, subject, existingData) {
  const existingCos = (existingData.companies || [])
    .map((c) => c.name).slice(0, 30).join(", ") || "none yet";
  const existingThemes = Object.keys(existingData.themes || {}).join(", ") || "none yet";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{
      role: "user",
      content: `You are a fintech venture analyst. Extract structured signals from this newsletter email.

Subject: ${subject}
Body:
---
${emailBody}
---

Already tracked companies: ${existingCos}
Already tracked themes: ${existingThemes}

Respond with ONLY a valid JSON object — no markdown, no explanation, nothing else:

{
  "issueDate": "YYYY-MM-DD",
  "issueTitle": "newsletter issue title",
  "companies": [
    {
      "name": "company name",
      "description": "one sentence: what they build and for whom",
      "stage": "pre-seed|seed|series-a|series-b|growth|unknown",
      "geography": "US|EU|UK|Asia|Global|unknown",
      "themes": ["specific theme 1", "specific theme 2"],
      "funding": {
        "amount": "$4.5M or unknown",
        "amountUSD": 4500000,
        "valuation": "$20M or unknown",
        "valuationUSD": 0,
        "round": "pre-seed|seed|series-a|series-b|unknown"
      },
      "exit": {
        "likely": "acquisition|IPO|unknown",
        "likelyAcquirer": "Company Name or null",
        "acquirerRationale": "one sentence strategic rationale"
      }
    }
  ],
  "themes": [
    {
      "name": "specific theme 2-4 words",
      "momentum": 7,
      "stage": "early|growing|mature",
      "description": "what is happening in this theme right now",
      "companyCount": 2
    }
  ]
}

Rules:
- amountUSD and valuationUSD must be integers (0 if unknown, never null)
- Only include companies explicitly mentioned in the email
- likelyAcquirer must be a real company (Stripe, Visa, Mastercard, JPMorgan, Adyen, Plaid, FIS, Fiserv, Revolut, Nubank, Goldman Sachs, etc.) or null
- Themes must be specific (e.g. "stablecoin treasury rails") not generic (e.g. "fintech")
- If the email has no fintech funding or product news, return empty arrays for companies and themes`
    }],
  });

  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  // Extract outermost JSON object
  let depth = 0, start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") { if (depth === 0) start = i; depth++; }
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  console.error("RAW CLAUDE RESPONSE (no JSON found):", raw.slice(0, 1000));
  throw new Error("No valid JSON in Claude response");
}

// ── Data merging ───────────────────────────────────────────────────────────

function mergeData(existing, parsed, subject) {
  const now = new Date().toISOString().slice(0, 10);

  // Issues history
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

  // Companies — deduplicate by name, merge on repeat
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
      for (const t of c.themes || []) {
        if (!ex.themes.includes(t)) ex.themes.push(t);
      }
    } else {
      companies.push({ ...c, mentions: 1, firstSeen: now, lastSeen: now });
    }
  }

  // Themes — deduplicate by name, compound momentum
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
    if (!Array.isArray(processedIds)) {
      console.warn("processed_email_ids is not an array, resetting");
      await kvSet("processed_email_ids", []);
    }

    const emails = await fetchResendEmails();
    const newEmails = emails.filter((e) => !processedIds.includes(e.id));

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
          console.log(`Skipping ${email.id}: body too short (${body.length} chars)`);
          continue;
        }

        const parsed = await extractSignals(
          body,
          details.subject || "This Week in Fintech",
          existing
        );

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
