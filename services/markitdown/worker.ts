import { Container } from "@cloudflare/containers";
export class Converter extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  envVars = { MARKITDOWN_SERVICE_TOKEN: "internal-service-binding-only" };
}
// No public route: only the ERP service binding can reach this Worker.
export default {
  async fetch(request: Request, env: { CONVERTER: DurableObjectNamespace<Converter> }) {
    const url = new URL(request.url);
    if (url.pathname !== "/convert" || request.method !== "POST") return new Response("Not found", {status:404});
    const headers = new Headers(request.headers);
    headers.set("authorization", "Bearer internal-service-binding-only");
    return env.CONVERTER.getByName("converter").fetch(new Request(request, {headers}));
  },
};
