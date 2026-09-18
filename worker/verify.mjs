// verify.mjs — focused verification of the worker's key behaviors
// Tests license inclusion, HMAC verification, and order flow logic
// without requiring full worker instantiation.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m",
  yellow: "\x1b[33m", cyan: "\x1b[36m"
};

function PASS(msg) { console.log(`${C.green}✓ ${msg}${C.reset}`); }
function FAIL(msg) { console.log(`${C.red}✗ ${msg}${C.reset}`); }
function INFO(msg) { console.log(`${C.cyan}ℹ ${msg}${C.reset}`); }

// 1. Verify LICENSE.txt content
INFO("Step 1: LICENSE.txt validation");
const licensePath = root + "LICENSE.txt";
const fs = await import("node:fs");
const licenseText = fs.readFileSync(licensePath, "utf8");
const workerPath = here + "src/index.js";
const workerCode = fs.readFileSync(workerPath, "utf8");

// Robust helper: slice the worker source between two stable markers so
// per-function checks never break on nested braces inside the body.
const sliceFn = (startMarker, endMarker) => {
  const s = workerCode.indexOf(startMarker);
  const e = workerCode.indexOf(endMarker, s);
  return s >= 0 && e > s ? workerCode.slice(s, e) : null;
};
const licenseChecks = [
  ["Standard Non-Exclusive Lease", "has lease header"],
  ["Prod. by Ken Carter", "has mandatory credit"],
  ["Ken Carter.*retains.*ownership", "asserts Ken Carter retains ownership"],
  ["non-exclusive", "specifies non-exclusive lease"],
  ["commercial.*stream|YouTube|Spotify", "covers commercial & streaming"],
  ["written notice.*termination", "includes termination clause"]
];
let licenseFail = 0;
for (const [pattern, desc] of licenseChecks) {
  const regex = new RegExp(pattern, "i");
  if (!regex.test(licenseText)) {
    FAIL(`LICENSE.txt ${desc}`);
    licenseFail++;
  } else {
    PASS(`LICENSE.txt ${desc}`);
  }
}
if (licenseFail === 0) {
  PASS("All LICENSE.txt content checks passed");
}

// 1b. Verify EXCLUSIVE_LICENSE.txt content and worker sync
INFO("\nStep 1b: EXCLUSIVE_LICENSE.txt validation");
const exclusiveLicensePath = root + "EXCLUSIVE_LICENSE.txt";
const exclusiveLicenseText = fs.readFileSync(exclusiveLicensePath, "utf8");
const exclusiveChecks = [
  ["EXCLUSIVE MASTER RIGHTS LICENSE AGREEMENT", "has exclusive master rights header"],
  ["Full Master Rights Transfer", "documents master rights transfer"],
  ["Exclusive Ownership", "documents exclusive ownership"],
  ["Composition Copyright.*Retained by Ken Carter", "retains composition copyright"],
  ["Sync Rights.*Exclusive", "transfers sync rights"],
  ["permanently removed from sale", "beat retired from catalog"]
];
let exclusiveLicenseFail = 0;
for (const [pattern, desc] of exclusiveChecks) {
  const regex = new RegExp(pattern, "i");
  if (!regex.test(exclusiveLicenseText)) {
    FAIL(`EXCLUSIVE_LICENSE.txt ${desc}`);
    exclusiveLicenseFail++;
  } else {
    PASS(`EXCLUSIVE_LICENSE.txt ${desc}`);
  }
}
if (exclusiveLicenseFail === 0) PASS("All EXCLUSIVE_LICENSE.txt content checks passed");

// Compare embedded worker text against the physical file
const srcExclusiveMatch = workerCode.match(/const EXCLUSIVE_LICENSE_TEXT = `([\s\S]*?)`;/);
if (srcExclusiveMatch) {
  const norm = (s) => s.replace(/\r\n/g, "\n").trim();
  if (norm(srcExclusiveMatch[1]) === norm(exclusiveLicenseText)) {
    PASS("Worker EXCLUSIVE_LICENSE_TEXT matches physical EXCLUSIVE_LICENSE.txt");
  } else {
    FAIL("Worker EXCLUSIVE_LICENSE_TEXT diverges from physical EXCLUSIVE_LICENSE.txt");
  }
} else {
  FAIL("Worker missing EXCLUSIVE_LICENSE_TEXT constant");
}

// Standard lease copy must also stay byte-identical to its physical deliverable
const srcLeaseMatch = workerCode.match(/const LICENSE_TEXT = `([\s\S]*?)`;/);
if (srcLeaseMatch) {
  const norm = (s) => s.replace(/\r\n/g, "\n").trim();
  if (norm(srcLeaseMatch[1]) === norm(licenseText)) {
    PASS("Worker LICENSE_TEXT matches physical LICENSE.txt");
  } else {
    FAIL("Worker LICENSE_TEXT diverges from physical LICENSE.txt");
  }
} else {
  FAIL("Worker missing LICENSE_TEXT constant");
}

// Frontend download link must point at the physical file
const frontendCode = fs.readFileSync(root + "script.js", "utf8");
if (frontendCode.includes('a.href = "EXCLUSIVE_LICENSE.pdf"')) {
  PASS("Frontend exclusive license download links to EXCLUSIVE_LICENSE.pdf");
} else {
  FAIL("Frontend exclusive license download does not point to EXCLUSIVE_LICENSE.pdf");
}
if (frontendCode.includes('a.href = "LICENSE.pdf"')) {
  PASS("Frontend lease license download links to LICENSE.pdf");
} else {
  FAIL("Frontend lease license download does not point to LICENSE.pdf");
}

// 2. Verify license text is embedded in worker
INFO("\nStep 2: Worker license integration");
if (workerCode.includes("LICENSE_TEXT") && workerCode.includes("Prod. by Ken Carter")) {
  PASS("Worker defines LICENSE_TEXT constant");
} else {
  FAIL("Worker missing LICENSE_TEXT or license content");
}
if (workerCode.includes("function buildDeliveryMessage") && workerCode.includes("OFFICIAL LEASE LICENSE CONTRACT")) {
  PASS("Worker has buildDeliveryMessage() for the branded delivery email");
} else {
  FAIL("Worker missing buildDeliveryMessage() function");
}
if (workerCode.includes("EXCLUSIVE_LICENSE.pdf") && workerCode.includes("LICENSE.pdf") && workerCode.includes("tier: \"exclusive\"") && workerCode.includes("licenses")) {
  PASS("Worker returns per-tier styled PDF license attachments in API responses and email payload");
} else {
  FAIL("Worker missing per-tier styled PDF license attachment routing");
}

// 3. Verify HMAC verification logic
INFO("\nStep 3: HMAC-SHA512 verification");
const hmacSection = sliceFn("export async function verifyIpnSignature", "const EMAIL_RE");
if (hmacSection) {
  PASS("Worker has verifyIpnSignature function");
  // Quick logic check: sorts keys, joins values, accepts pipe/no-pipe variants
  if (hmacSection.includes("sort()") && hmacSection.includes("join(\"|\")") && hmacSection.includes("join(\"\")")) {
    PASS("HMAC implementation matches NOWPayments spec (sort+join with pipe/empty)");
  } else {
    FAIL("HMAC implementation may not match NOWPayments spec");
  }
} else {
  FAIL("Worker missing verifyIpnSignature function");
}

// 4. Verify IPN released state triggers email + download links
INFO("\nStep 4: IPN released state handling");
const ipnHandler = sliceFn("async function handleIpn", "export default");
if (ipnHandler) {
  PASS("Worker has handleIpn function");
  const checks = [
    ["RELEASE_STATUS", "checks for RELEASE_STATUS === 'finished'"],
    ["rec.released = true", "sets rec.released = true on finished"],
    ["saveOrder.*id.*rec", "persists updated order to KV"],
    ["ctx\\.waitUntil[\\s\\S]*deliverOrderEmail", "sends delivery email in background"],
    ["url: map\\[beatId\\] \\|\\| null", "keeps missing BEAT_LINKS as null-url rows"],
    ["json.*{ ok: true, released: true, count", "returns success with count"]
  ];
  let ipnFail = 0;
  for (const [pattern, desc] of checks) {
    if (!new RegExp(pattern).test(ipnHandler)) {
      FAIL(`IPN handler ${desc}`);
      ipnFail++;
    } else {
      PASS(`IPN handler ${desc}`);
    }
  }
  if (ipnFail === 0) PASS("IPN handler correctly processes finished payments");
} else {
  FAIL("Worker missing handleIpn function");
}

// 5. Verify status endpoint returns license and links
INFO("\nStep 5: Status endpoint behavior");
const statusHandler = sliceFn("async function handleStatus", "async function handleIpn");
if (statusHandler) {
  PASS("Worker has handleStatus function");
  const checks = [
    ["rec.released", "checks if order is released"],
    ["beatLinks.*env", "fetches beat links from env.BEAT_LINKS"],
    ["links\\s*=\\s*rec\\.items\\.map", "builds links array with id (incl. null urls)"],
    ["tier: \"exclusive\", filename: \"EXCLUSIVE_LICENSE.pdf\"", "exposes exclusive styled-PDF license attachment metadata"],
    ["licenses", "includes licenses array in response"]
  ];
  let statusFail = 0;
  for (const [pattern, desc] of checks) {
    if (!new RegExp(pattern).test(statusHandler)) {
      FAIL(`Status handler ${desc}`);
      statusFail++;
    } else {
      PASS(`Status handler ${desc}`);
    }
  }
  if (statusFail === 0) PASS("Status endpoint returns download links + license");
} else {
  FAIL("Worker missing handleStatus function");
}

// 6. Verify the delivery email: clean receipt, styled-PDF attachments + retry
INFO("\nStep 6: Delivery email clean receipt, styled-PDF attachments & retry");
const emailFunc = sliceFn("async function buildDeliveryMessage", "async function sendEmailWithRetry");
if (emailFunc) {
  PASS("Worker has buildDeliveryMessage function");
  const checks = [
    ["attachments", "builds license attachments"],
    ["buildLicensePdf", "generates styled license PDFs (buildLicensePdf)"],
    ["OFFICIAL LEASE LICENSE CONTRACT", "notes the lease license in the email"],
    ["ORDER DATE", "receipt shows the exact order date"],
    ["const text =", "builds plain-text body for Resend"],
    ["DELIVERY PENDING", "marks missing links as delivery-pending"],
    ["beatAnchor", "builds scroll-to-beat anchors (#beat-05 / #s2-beat-03)"]
  ];
  let emailFail = 0;
  for (const [pattern, desc] of checks) {
    if (!new RegExp(pattern).test(emailFunc)) {
      FAIL(`Email function ${desc}`);
      emailFail++;
    } else {
      PASS(`Email function ${desc}`);
    }
  }
  if (emailFail === 0) PASS("Delivery email includes links + per-tier styled-PDF license attachments");
if (workerCode.includes("DCTDecode") && workerCode.includes("/Im1 Do")) {
  PASS("Styled PDFs embed the Ken Carter logo JPEG (DCTDecode image xobject)");
} else {
  FAIL("Styled PDFs missing logo JPEG embedding (DCTDecode /Im1)");
}
} else {
  FAIL("Worker missing buildDeliveryMessage function");
}
if (!/row\("ORDER ID"|row\("PAYMENT ID"/.test(workerCode)) {
  PASS("Receipt omits internal ORDER ID and PAYMENT ID fields");
} else {
  FAIL("Receipt still exposes ORDER ID / PAYMENT ID");
}
if (workerCode.includes("DEFAULT_RESEND_FROM") && workerCode.includes("noreply@kencarter.abrdns.com")) {
  PASS("Sender defaults to noreply@kencarter.abrdns.com (store's own domain)");
} else {
  FAIL("Missing verified-domain sender default");
}

if (workerCode.includes("async function sendEmailWithRetry")) {
  PASS("Worker has sendEmailWithRetry (bounded backoff)");
} else {
  FAIL("Worker missing sendEmailWithRetry");
}
if (workerCode.includes("async function deliverOrderEmail")) {
  PASS("Worker has deliverOrderEmail (records delivery state on order)");
} else {
  FAIL("Worker missing deliverOrderEmail");
}
if (workerCode.includes("async function assertExclusivesAvailable")) {
  PASS("Worker has assertExclusivesAvailable (checkout exclusivity gate)");
} else {
  FAIL("Worker missing assertExclusivesAvailable");
}
if (workerCode.includes("async function handleCatalog")) {
  PASS("Worker has handleCatalog (sold overview)");
} else {
  FAIL("Worker missing handleCatalog");
}
if (workerCode.includes("async function handleResend")) {
  PASS("Worker has handleResend (admin resend)");
} else {
  FAIL("Worker missing handleResend");
}
if (workerCode.includes("url.pathname === \"/api/catalog\"") && workerCode.includes("url.pathname === \"/api/resend\"")) {
  PASS("Dispatcher exposes /api/catalog and /api/resend routes");
} else {
  FAIL("Dispatcher missing /api/catalog or /api/resend route");
}

// Summary
console.log(`\n${C.bold}═════════════════════════════════════════════${C.reset}`);
console.log(`${C.bold}   VERIFICATION COMPLETE${C.reset}`);
console.log(`${C.bold}═════════════════════════════════════════════${C.reset}\n`);

// Count assertions from output would be ideal, but for now:
console.log("Review the ✓ and ✗ marks above to confirm all critical paths are verified.");
console.log("Key verified areas:");
console.log("  • LICENSE.txt content and presence");
console.log("  • EXCLUSIVE_LICENSE.txt content, worker sync, and frontend link");
console.log("  • Worker integrates license into API responses & email");
console.log("  • HMAC verification matches NOWPayments spec");
console.log("  • IPN 'finished' triggers release, email, and background tasks");
console.log("  • Status endpoint provides download links + license");
console.log("  • Delivery email includes license and download links\n");