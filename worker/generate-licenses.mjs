// Regenerates the site-root sample license PDFs (LICENSE.pdf and
// EXCLUSIVE_LICENSE.pdf) that the store's purchase popup links point to.
// Uses the exact same emitter the Worker attaches to delivery emails, so the
// downloadable reference and the emailed contract are produced identically.
//
//   node worker/generate-licenses.mjs
//
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLicensePdf, orderDateLabel } from "./src/index.js";

const root = join(new URL("..", import.meta.url).pathname);
const orderDate = orderDateLabel(Date.now());
const sample = {
  beats: "BEAT 01 \u2014 CH\u00a3$$\nBEAT 02 \u2014 AnGeLL",
  licensee: "customer@example.com",
  orderDate,
  totalText: "$29.90"
};

for (const [kind, file] of [["lease", "LICENSE.pdf"], ["exclusive", "EXCLUSIVE_LICENSE.pdf"]]) {
  const b64 = await buildLicensePdf({ kind, ...sample });
  writeFileSync(join(root, file), Buffer.from(b64, "base64"));
  console.log(`${file} written (${(Buffer.from(b64, "base64").length / 1024).toFixed(1)} KiB)`);
}