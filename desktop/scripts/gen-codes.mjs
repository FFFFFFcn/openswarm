#!/usr/bin/env node
// Invite-code generator for the desktop gate.
//
//   node gen-codes.mjs --random 5      generate 5 random codes + hashes
//   node gen-codes.mjs CODE1 CODE2     hash the given plaintext codes
//
// Paste the printed hashes into INVITE_CODE_HASHES in desktop/main.js.
// Keep the plaintext codes somewhere safe: they are not recoverable.
import { createHash, randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomCode() {
  const group = () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `OSWM-${group()}-${group()}-${group()}`;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const args = process.argv.slice(2);
let codes;
if (args[0] === "--random") {
  const count = Number(args[1] || 5);
  codes = Array.from({ length: count }, randomCode);
} else if (args.length > 0) {
  codes = args.map((c) => c.trim().toUpperCase());
} else {
  console.error("Usage: node gen-codes.mjs --random <n> | node gen-codes.mjs CODE...");
  process.exit(1);
}

console.log("code -> sha256\n");
for (const code of codes) {
  console.log(`${code}  ${sha256(code)}`);
}
console.log("\nINVITE_CODE_HASHES = [");
for (const code of codes) {
  console.log(`  "${sha256(code)}",`);
}
console.log("];");
