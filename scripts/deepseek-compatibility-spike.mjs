import { writeFile } from "node:fs/promises";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const baseUrl = (process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/beta").replace(/\/+$/, "");
const models = [
  process.env.DEEPSEEK_MODEL_FAST?.trim() || "deepseek-v4-flash",
  process.env.DEEPSEEK_MODEL_COMPLEX?.trim() || "deepseek-v4-pro",
];
const outputArg = process.argv.find((value) => value.startsWith("--output="));

if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is required. No live compatibility claims were recorded.");
  process.exitCode = 2;
} else {
  const results = [];
  const tool = {
    type: "function",
    function: {
      name: "echo_code", description: "Return one code", strict: true,
      parameters: { type: "object", additionalProperties: false, properties: { code: { type: "string", pattern: "^[A-Z]{3}-[0-9]{3}$" } }, required: ["code"] },
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
      const normal = await request({ model, messages: [{ role: "user", content: "Reply with exactly OK." }], stream: false, max_tokens: 20, thinking: { type: "disabled" } });
      results.push({ model, check: "normal_chat", ok: normal.response.ok && Boolean(normal.payload?.choices?.[0]?.message?.content), status: normal.response.status, latency_ms: normal.latency_ms, usage_present: Boolean(normal.payload?.usage) });

      const forced = await request({ model, messages: [{ role: "user", content: "Call echo_code with ABC-123." }], tools: [tool], tool_choice: { type: "function", function: { name: "echo_code" } }, stream: false, thinking: { type: "disabled" } });
      const call = forced.payload?.choices?.[0]?.message?.tool_calls?.[0];
      let validArgs = false;
      try { validArgs = JSON.parse(call?.function?.arguments || "null")?.code === "ABC-123"; } catch {}
      results.push({ model, check: "strict_tool_call", ok: forced.response.ok && call?.function?.name === "echo_code" && validArgs, status: forced.response.status, latency_ms: forced.latency_ms, usage_present: Boolean(forced.payload?.usage) });

      if (call?.id) {
        const multi = await request({ model, messages: [
          { role: "user", content: "Call echo_code with ABC-123, then tell me the returned code." },
          forced.payload.choices[0].message,
          { role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true, code: "ABC-123" }) },
        ], tools: [tool], stream: false, thinking: { type: "disabled" } });
        results.push({ model, check: "tool_result_final", ok: multi.response.ok && Boolean(multi.payload?.choices?.[0]?.message?.content), status: multi.response.status, latency_ms: multi.latency_ms, usage_present: Boolean(multi.payload?.usage) });
      }

      const stream = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply OK." }], stream: true, stream_options: { include_usage: true }, max_tokens: 20, thinking: { type: "disabled" } }),
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
