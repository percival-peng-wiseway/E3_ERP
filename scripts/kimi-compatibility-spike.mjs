import { writeFile } from "node:fs/promises";

const apiKey = (process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY)?.trim();
const baseUrl = (process.env.KIMI_BASE_URL?.trim() || "https://api.moonshot.ai/v1").replace(/\/+$/, "");
const models = [process.env.KIMI_MODEL_NAME?.trim() || "kimi-k2.6"];
const outputArg = process.argv.find((value) => value.startsWith("--output="));

if (!apiKey) {
  console.error("MOONSHOT_API_KEY is required. No live compatibility claims were recorded.");
  process.exitCode = 2;
} else {
  const results = [];
  const tool = {
    type: "function",
    function: {
      name: "echo_code", description: "Return one code", strict: true,
      parameters: { type: "object", additionalProperties: false, properties: { code: { type: "string", description: "Code formatted like ABC-123." } }, required: ["code"] },
    },
  };

  async function request(body, timeoutMs = 60_000) {
    const started = performance.now();
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "manual",
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { invalid_json: true }; }
    return { response, payload, latency_ms: Math.round(performance.now() - started) };
  }

  for (const model of models) {
    try {
      const normal = await request({ model, messages: [{ role: "user", content: "Reply with exactly OK." }], stream: false, max_completion_tokens: 20, thinking: { type: "disabled" } });
      results.push({ model, check: "normal_chat", ok: normal.response.ok && normal.payload?.choices?.[0]?.finish_reason === "stop" && Boolean(normal.payload?.choices?.[0]?.message?.content), status: normal.response.status, latency_ms: normal.latency_ms, usage_present: Boolean(normal.payload?.usage) });

      const forcedMessages = [{ role: "user", content: "Call echo_code with ABC-123." }];
      const forced = await request({ model, messages: forcedMessages, tools: [tool], tool_choice: { type: "function", function: { name: "echo_code" } }, stream: false, thinking: { type: "disabled" } });
      const call = forced.payload?.choices?.[0]?.message?.tool_calls?.[0];
      let validArgs = false;
      try { validArgs = JSON.parse(call?.function?.arguments || "null")?.code === "ABC-123"; } catch {}
      results.push({ model, check: "strict_tool_call", ok: forced.response.ok && forced.payload?.choices?.[0]?.finish_reason === "tool_calls" && call?.function?.name === "echo_code" && validArgs, status: forced.response.status, latency_ms: forced.latency_ms, usage_present: Boolean(forced.payload?.usage) });

      if (call?.id) {
        const multi = await request({ model, messages: [
          ...forcedMessages,
          forced.payload.choices[0].message,
          { role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true, code: "ABC-123" }) },
        ], tools: [tool], stream: false, thinking: { type: "disabled" } });
        results.push({ model, check: "tool_result_final", ok: multi.response.ok && multi.payload?.choices?.[0]?.finish_reason === "stop" && Boolean(multi.payload?.choices?.[0]?.message?.content), status: multi.response.status, latency_ms: multi.latency_ms, usage_present: Boolean(multi.payload?.usage) });
      }

      const structured = await request({
        model,
        messages: [{ role: "system", content: "Return only JSON." }, { role: "user", content: "Return an object with ok set to true." }],
        response_format: { type: "json_object" }, stream: false, thinking: { type: "disabled" },
      });
      let validJson = false;
      try { validJson = JSON.parse(structured.payload?.choices?.[0]?.message?.content || "null")?.ok === true; } catch {}
      results.push({ model, check: "json_object", ok: structured.response.ok && structured.payload?.choices?.[0]?.finish_reason === "stop" && validJson, status: structured.response.status, latency_ms: structured.latency_ms, usage_present: Boolean(structured.payload?.usage) });

      const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const vision = await request({
        model,
        messages: [{ role: "user", content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${tinyPng}` } },
          { type: "text", text: "Inspect the image, then call echo_code with IMG-123." },
        ] }],
        tools: [tool], tool_choice: { type: "function", function: { name: "echo_code" } },
        stream: false, thinking: { type: "disabled" },
      });
      const visionCall = vision.payload?.choices?.[0]?.message?.tool_calls?.[0];
      let validVisionArgs = false;
      try { validVisionArgs = JSON.parse(visionCall?.function?.arguments || "null")?.code === "IMG-123"; } catch {}
      results.push({ model, check: "vision_tool_call", ok: vision.response.ok && vision.payload?.choices?.[0]?.finish_reason === "tool_calls" && visionCall?.function?.name === "echo_code" && validVisionArgs, status: vision.response.status, latency_ms: vision.latency_ms, usage_present: Boolean(vision.payload?.usage) });

      const stream = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply OK." }], stream: true, stream_options: { include_usage: true }, max_completion_tokens: 20, thinking: { type: "disabled" } }),
        signal: AbortSignal.timeout(60_000), redirect: "manual",
      });
      const streamText = await stream.text();
      results.push({ model, check: "streaming_usage", ok: stream.ok && streamText.includes("data:") && streamText.includes("[DONE]") && streamText.includes('"usage"'), status: stream.status });

      let timeoutOk = false;
      try { await request({ model, messages: [{ role: "user", content: "Hello" }] }, 1); } catch (error) { timeoutOk = error?.name === "TimeoutError" || error?.name === "AbortError"; }
      results.push({ model, check: "client_timeout", ok: timeoutOk });
    } catch (error) {
      results.push({ model, check: "spike_exception", ok: false, error_type: error instanceof Error ? error.name : "UnknownError" });
    }
  }

  try {
    const invalid = await request({ model: models[0], messages: [{ role: "user", content: "test" }], tools: [{ ...tool, function: { ...tool.function, parameters: { type: "unsupported" } } }] });
    results.push({ model: models[0], check: "safe_error_format", ok: !invalid.response.ok && Boolean(invalid.payload?.error), status: invalid.response.status });
  } catch (error) {
    results.push({ model: models[0], check: "safe_error_format", ok: false, error_type: error instanceof Error ? error.name : "UnknownError" });
  }

  const report = { executed_at: new Date().toISOString(), base_url_origin: new URL(baseUrl).origin, results, passed: results.every((item) => item.ok) };
  console.log(JSON.stringify(report, null, 2));
  if (outputArg) await writeFile(outputArg.slice("--output=".length), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (!report.passed) process.exitCode = 1;
}
