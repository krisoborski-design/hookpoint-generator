const https = require("https");

const HIGGSFIELD_MCP = "https://mcp.higgsfield.ai/mcp";

async function mcpRequest(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  return new Promise((resolve, reject) => {
    const url = new URL(HIGGSFIELD_MCP);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const HIGGSFIELD_API_KEY = process.env.HIGGSFIELD_API_KEY;
  if (!HIGGSFIELD_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing HIGGSFIELD_API_KEY" }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json"
  };

  try {
    if (body.action === "upload") {
      // Upload image to Higgsfield
      const response = await fetch("https://api.higgsfield.ai/v1/media/upload", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HIGGSFIELD_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: "image",
          mime_type: body.mimeType || "image/jpeg"
        })
      });
      const uploadInfo = await response.json();

      if (!uploadInfo.upload_url) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "No upload_url from Higgsfield", detail: uploadInfo }) };
      }

      // PUT image bytes to S3
      const imageBuffer = Buffer.from(body.image, "base64");
      await fetch(uploadInfo.upload_url, {
        method: "PUT",
        headers: { "Content-Type": body.mimeType || "image/jpeg" },
        body: imageBuffer
      });

      // Confirm upload
      const confirmResp = await fetch("https://api.higgsfield.ai/v1/media/confirm", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HIGGSFIELD_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ media_id: uploadInfo.media_id })
      });
      const confirmed = await confirmResp.json();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          media_id: uploadInfo.media_id,
          url: confirmed.url || uploadInfo.cdn_url || ""
        })
      };
    }

    if (body.action === "generate") {
      const prompt = `${body.hook_category} hook: ${body.hook_text}. Portrait shot, selfie style, vertical 9:16 format, cinematic social media hook, engaging facial expression, high quality`;

      const response = await fetch("https://api.higgsfield.ai/v1/generate/video", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HIGGSFIELD_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "kling3_0",
          prompt,
          aspect_ratio: "9:16",
          duration: 5,
          mode: "std",
          medias: [{ role: "start_image", value: body.media_id, url: body.media_url }]
        })
      });
      const genData = await response.json();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ job_id: genData.id || genData.job_id })
      };
    }

    if (body.action === "poll") {
      const response = await fetch(`https://api.higgsfield.ai/v1/jobs/${body.job_id}`, {
        headers: { "Authorization": `Bearer ${HIGGSFIELD_API_KEY}` }
      });
      const jobData = await response.json();

      const status = jobData.status || "processing";
      let video_url = null;

      if (status === "completed" || status === "done") {
        video_url = jobData.results?.[0]?.url || jobData.result_url || jobData.url || null;
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status, video_url })
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
