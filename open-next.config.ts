import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// This project currently uses dynamic route handlers and does not depend on
// Next.js incremental revalidation, so no R2 incremental-cache bucket is
// required for the first deployment.
const cloudflareConfig = defineCloudflareConfig();

// OpenNext otherwise shells out to npm, which is not guaranteed to be on PATH
// when the repository is built with the bundled Node runtime.
cloudflareConfig.buildCommand = `"${process.execPath}" node_modules/next/dist/bin/next build`;

export default cloudflareConfig;
