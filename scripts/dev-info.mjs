import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readEnvValue(envPath, key) {
  try {
    const content = readFileSync(resolve(root, envPath), "utf-8");
    const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match ? match[1].trim() || "(empty — will use fallback URL)" : "(not set)";
  } catch {
    return "(file not found)";
  }
}

const isRemote = process.argv.includes("--remote");

setTimeout(() => {
  const envFile = isRemote ? ".env.remote" : ".env";
  const extApi = readEnvValue(envFile, "VITE_EXTENSION_API_ENDPOINT");
  const pwaApi = readEnvValue(envFile, "VITE_PWA_API_ENDPOINT");
  const kv = isRemote ? "deployed (dev worker)" : "local (simulated)";

  const lines = [
    `  Extension API:  ${extApi}`,
    `  PWA API:        ${pwaApi}`,
    `  Worker KV:      ${kv}`,
  ];
  const width = Math.max(...lines.map((l) => l.length)) + 2;

  console.log("");
  console.log("┌" + "─".repeat(width) + "┐");
  for (const line of lines) {
    console.log("│" + line.padEnd(width) + "│");
  }
  console.log("└" + "─".repeat(width) + "┘");
  console.log("");
}, 8000);
