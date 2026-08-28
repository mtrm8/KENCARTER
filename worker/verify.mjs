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
if (frontendCode.includes('a.href = "EXCLUSIVE_LICENSE.txt"')) {
  PASS("Frontend exclusive license download links to EXCLUSIVE_LICENSE.txt");
} else {
  FAIL("Frontend exclusive license download does not point to EXCLUSIVE_LICENSE.txt");
}

// 2. Verify license text is embedded in worker
INFO("\nStep 2: Worker license integration");
if (workerCode.includes("LICENSE_TEXT") && workerCode.includes("Prod. by Ken Carter")) {
  PASS("Worker defines LICENSE_TEXT constant");
} else {
  FAIL("Worker missing LICENSE_TEXT or license content");
}
if (workerCode.includes("licenseHtml()") && workerCode.includes("OFFICIAL LEASE LICENSE CONTRACT")) {
  PASS("Worker has licenseHtml() function for email");
} else {
  FAIL("Worker missing licenseHtml() function");
}
if (workerCode.includes("EXCLUSIVE_LICENSE_TEXT") && workerCode.includes("LicenseText: isExclusive ? EXCLUSIVE_LICENSE_TEXT : LICENSE_TEXT")) {
  PASS("Worker returns exclusive lease license in API responses and email payload");
} else {
  FAIL("Worker missing exclusive license in API/email payload");
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
    ["ctx\\.waitUntil[\\s\\S]*sendDeliveryEmail", "sends email in background"],
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
    ["enrichedLinks\\s*=\\s*rec\\.items", "builds links array for response"],
    ["EXCLUSIVE_LICENSE_TEXT", "selects exclusive license text for exclusive orders"],
    ["license", "includes license in response"]
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

// 6. Verify delivery email includes license
INFO("\nStep 6: Delivery email license inclusion");
const emailFunc = sliceFn("async function sendDeliveryEmail", "async function saveOrder");
if (emailFunc) {
  PASS("Worker has sendDeliveryEmail function");
  const checks = [
    ["deliveryHtml.*links", "includes download links in email"],
    ["licenseHtml()", "adds formatted license to email"],
    ["LicenseText:", "includes raw license text for StaticForms"]
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
  if (emailFail === 0) PASS("Delivery email includes both links and full license");
} else {
  FAIL("Worker missing sendDeliveryEmail function");
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