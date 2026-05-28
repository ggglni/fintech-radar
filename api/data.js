// api/data.js
// Serves radar data from Upstash KV to the frontend

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const response = await fetch(`${process.env.KV_REST_API_URL}/get/radar_data`, {
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
    });
    const json = await response.json();
    const data = json.result ? JSON.parse(json.result) : {
      companies: [], themes: {}, issues: [], lastUpdated: null
    };
    return res.status(200).json(data);
  } catch (err) {
    console.error("Data fetch error:", err);
    return res.status(500).json({ error: err.message });
  }
}
