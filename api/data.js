// api/data.js
// Serves radar data from Upstash KV to the frontend

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const response = await fetch(
      `${process.env.KV_REST_API_URL}/get/radar_data`,
      { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` } }
    );
    const json = await response.json();

    if (!json.result) {
      return res.status(200).json({ companies: [], themes: {}, issues: [], lastUpdated: null });
    }

    let data = json.result;
    try { data = JSON.parse(data); } catch { /* already an object */ }

    return res.status(200).json(data);
  } catch (err) {
    console.error("Data fetch error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
