import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// This project currently uses dynamic route handlers and does not depend on
// Next.js incremental revalidation, so no R2 incremental-cache bucket is
// required for the first deployment.
export default defineCloudflareConfig();
