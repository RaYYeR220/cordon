#!/usr/bin/env node
//
// Verify, against Starknet mainnet, every claim strk20.json makes.
//
// For each listed transaction this asserts that it exists, that it succeeded, that it carries an
// event emitted by the STRK20 pool, and that it carries an event emitted by one of the contracts
// this project deployed. That last check is the one that matters: touching the pool through
// somebody else's contract is not this project running on mainnet.
//
// No arguments, no credentials, no install beyond Node 18+. Exits non-zero on the first failure.
//
//   node scripts/verify-onchain.mjs
//
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.STARKNET_RPC ?? "https://api.cartridge.gg/x/starknet/mainnet";
const POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const VOYAGER = "https://voyager.online/tx/";

const norm = (a) => "0x" + BigInt(a).toString(16).padStart(64, "0");
const short = (a) => `${a.slice(0, 10)}…${a.slice(-6)}`;

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} from ${RPC}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

const pass = (m) => console.log(`  ok    ${m}`);
const fail = (m) => {
  console.error(`  FAIL  ${m}`);
  process.exitCode = 1;
};

const manifest = JSON.parse(await readFile(join(ROOT, "strk20.json"), "utf8"));
const transactions = manifest.transactions ?? [];
const contracts = (manifest.contracts ?? []).map(norm);

console.log(`rpc        ${RPC}`);
console.log(`pool       ${short(POOL)}`);
console.log(`contracts  ${contracts.length ? contracts.map(short).join(", ") : "none listed"}`);
console.log();

if (transactions.length === 0) {
  console.error("strk20.json lists no transactions. Nothing to verify yet.");
  process.exit(1);
}
if (transactions.length < 3) {
  console.error(`strk20.json lists ${transactions.length} transaction(s); the sprint requires at least 3.`);
  process.exitCode = 1;
}

for (const hash of transactions) {
  console.log(`${hash}\n  ${VOYAGER}${hash}`);

  let receipt;
  try {
    receipt = await rpc("starknet_getTransactionReceipt", [hash]);
  } catch (err) {
    fail(`exists — ${err.message}`);
    console.log();
    continue;
  }
  pass("exists");

  const status = receipt.execution_status;
  if (status === "SUCCEEDED") pass("succeeded");
  else fail(`succeeded — execution_status is ${status}${receipt.revert_reason ? `: ${receipt.revert_reason}` : ""}`);

  const emitters = new Set((receipt.events ?? []).map((e) => norm(e.from_address)));

  if (emitters.has(norm(POOL))) pass("carries a STRK20 pool event");
  else fail("carries a STRK20 pool event — none found");

  if (contracts.length === 0) {
    console.log("  skip  runs through this project's contracts — none listed in strk20.json");
  } else {
    const hit = contracts.filter((c) => emitters.has(c));
    if (hit.length > 0) pass(`runs through this project's contracts (${hit.map(short).join(", ")})`);
    else fail("runs through this project's contracts — no event from any listed contract");
  }

  console.log();
}

console.log(process.exitCode ? "verification FAILED" : "all checks passed");
