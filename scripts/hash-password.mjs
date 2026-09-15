/**
 * Reads a password from stdin and prints a scrypt hash. Does not echo.
 * Usage: node scripts/hash-password.mjs
 */
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { hashPassword } from "../server/password.js";

const rl = createInterface({ input, output, terminal: true });
output.write("Password (not stored): ");
rl.question("", async (pwd) => {
  rl.close();
  const out = await hashPassword(pwd);
  if (!out.ok) {
    console.error(out.error);
    process.exit(1);
  }
  console.log(out.hash);
});
