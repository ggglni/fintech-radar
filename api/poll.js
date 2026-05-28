// api/poll.js
// Called by Vercel cron every day at 9am
// Fetches new emails from Resend and processes them through Claude

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Upstash helpers
async function kvGet(key) {
  const res = await fetch(`${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  const json = await res.json();
  return json.result ? JSON.parse(json.result) : null;
}

async function kvSet(key, value) {
  await fetch(`${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(JSON.stringify(value)),
  });
}

// Fetch received emails from Resend API
async function fetchResendEmails() {
  const res = await fetch("https://api.resend.com/emails/receiving?limit=20", {
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
  });
  const json = await res.json();
  return json.data || [];
}

// Fetch full email details including body
async function fetchEmailDetails(emailId) {
  const res = await fetch(`https://api.resend.com/emails/${emailId}`, {
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
  });
  return res.json();
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
${emailBody.slice(0, 12000)}
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

  return { companies, themes, issues: issues.slice(0, 50), lastUpdated: now };
}

export default async function handler(req, res) {
  // Allow manual trigger via GET, cron via GET as well
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Load already-processed email IDs to avoid duplicates
    const processedIds = (await kvGet("processed_email_ids")) || [];
    const emails = await fetchResendEmails();

    // Filter to only inbound emails not yet processed
    const newEmails = emails.filter(e =>
      !processedIds.includes(e.id)
    );

    if (!newEmails.length) {
      return res.status(200).json({ ok: true, message: "No new emails to process" });
    }

    let existing = (await kvGet("radar_data")) || {};
    const newProcessedIds = [...processedIds];
    let processed = 0;

    for (const email of newEmails) {
      try {
        const details = await fetchEmailDetails(email.id);
console.log("EMAIL DETAILS:", JSON.stringify(details).slice(0, 500));
const body = details.text || (details.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
if (!body || body.length < 100) {
  console.log("BODY TOO SHORT:", body?.length, body?.slice(0, 100));
  continue;
}

        const parsed = await extractSignals(body, details.subject || "This Week in Fintech", existing);
        existing = mergeData(existing, parsed, details.subject || "This Week in Fintech");
        newProcessedIds.push(email.id);
        processed++;
      } catch (e) {
        console.error(`Failed to process email ${email.id}:`, e.message);
      }
    }

    await kvSet("radar_data", existing);
    await kvSet("processed_email_ids", newProcessedIds.slice(-200)); // keep last 200

    return res.status(200).json({ ok: true, processed, total: newEmails.length });
  } catch (err) {
    console.error("Poll error:", err);
    return res.status(500).json({ error: err.message });
  }
}
