// api/inbound.js
// Receives inbound email webhooks from Resend
// Extracts fintech signals via Claude, stores in Upstash KV

import Anthropic from "anthropic";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Upstash REST helpers
async function kvGet(key) {
  const res = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  const json = await res.json();
  return json.result ? JSON.parse(json.result) : null;
}

async function kvSet(key, value) {
  await fetch(`${process.env.KV_REST_API_URL}/set/${key}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(JSON.stringify(value)),
  });
}

function extractEmailBody(payload) {
  const text = payload.text || "";
  const html = payload.html || "";
  if (text && text.length > 100) return text.slice(0, 12000);
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 12000);
}

async function extractSignals(emailBody, subject, existingData) {
  const existingCos = (existingData.companies || []).map((c) => c.name).slice(0, 30).join(", ") || "none yet";
  const existingThemes = Object.keys(existingData.themes || {}).join(", ") || "none yet";

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 2000,
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

Respond with ONLY a valid JSON object, nothing else before or after it:

{
  "issueDate": "YYYY-MM-DD or approximate",
  "issueTitle": "subject line or inferred title",
  "companies": [
    {
      "name": "string",
      "description": "one sentence what they build",
      "stage": "pre-seed|seed|series-a|series-b|growth|unknown",
      "geography": "US|EU|UK|Asia|Global|unknown",
      "themes": ["theme1","theme2"],
      "funding": {
        "amount": "e.g. $4.5M or unknown",
        "amountUSD": 4500000,
        "valuation": "e.g. $20M or unknown",
        "valuationUSD": 0,
        "round": "pre-seed|seed|series-a|series-b|unknown"
      },
      "exit": {
        "likely": "acquisition|IPO|unknown",
        "likelyAcquirer": "company name or null",
        "acquirerRationale": "one sentence why"
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
- amountUSD and valuationUSD must be numbers, use 0 if unknown
- likelyAcquirer: real company name (Stripe, Visa, Mastercard, JPMorgan, Adyen, Plaid, FIS, Fiserv, Revolut, Nubank, etc.) or null
- Only include companies explicitly mentioned in the email
- Themes should be specific (e.g. "embedded lending", "stablecoin treasury", "agentic payments") not generic`
    }],
  });

  const raw = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");

  // Robust JSON extraction
  let depth = 0, start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") { if (depth === 0) start = i; depth++; }
    else if (raw[i] === "}") { depth--; if (depth === 0 && start !== -1) {
      return JSON.parse(raw.slice(start, i + 1));
    }}
  }
  throw new Error("No valid JSON in Claude response");
}

function mergeData(existing, parsed, subject) {
  const now = new Date().toISOString().slice(0, 10);

  const issues = existing.issues || [];
  issues.unshift({
    date: parsed.issueDate || now,
    title: parsed.issueTitle || subject,
    companyCount: (parsed.companies || []).length,
    themeCount: (parsed.themes || []).length,
    receivedAt: now,
  });

  const companies = existing.companies || [];
  (parsed.companies || []).forEach((c) => {
    const ex = companies.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
    if (ex) {
      ex.mentions = (ex.mentions || 1) + 1;
      ex.lastSeen = now;
      if ((c.funding?.amountUSD || 0) > 0) ex.funding = c.funding;
      if (c.exit?.likelyAcquirer) ex.exit = c.exit;
      ex.description = c.description || ex.description;
      (c.themes || []).forEach((t) => { if (!ex.themes.includes(t)) ex.themes.push(t); });
    } else {
      companies.push({ ...c, mentions: 1, firstSeen: now, lastSeen: now });
    }
  });

  const themes = existing.themes || {};
  (parsed.themes || []).forEach((t) => {
    const key = t.name.toLowerCase();
    if (themes[key]) {
      themes[key].momentum = Math.max(themes[key].momentum, t.momentum);
      themes[key].signalCount = (themes[key].signalCount || 1) + 1;
      themes[key].lastSeen = now;
      themes[key].description = t.description;
    } else {
      themes[key] = { ...t, signalCount: 1, firstSeen: now, lastSeen: now };
    }
  });

  return {
    companies,
    themes,
    issues: issues.slice(0, 50),
    lastUpdated: now,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const payload = req.body;
    const subject = payload.subject || payload.headers?.subject || "This Week in Fintech";
    const emailBody = extractEmailBody(payload);

    if (!emailBody || emailBody.length < 100) {
      return res.status(400).json({ error: "Email body too short or empty" });
    }

    const existing = (await kvGet("radar_data")) || {};
    const parsed = await extractSignals(emailBody, subject, existing);
    const updated = mergeData(existing, parsed, subject);
    await kvSet("radar_data", updated);

    console.log(`Processed: ${subject} — ${(parsed.companies || []).length} companies`);
    return res.status(200).json({ ok: true, companies: (parsed.companies || []).length });

  } catch (err) {
    console.error("Inbound error:", err);
    return res.status(500).json({ error: err.message });
  }
}
