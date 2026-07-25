// PreToolUse(Bash) hook: block PowerShell here-string syntax @'...'@ inside the Bash tool.
//
// The environment's interactive shell is PowerShell, but the Bash tool runs bash, which
// does NOT understand @'...'@. bash treats the leading @ and trailing @ as literal
// characters, silently prepending/appending a stray "@" to the argument — this corrupted
// several `git commit -m` messages and `gh pr create --body` bodies (a lone "@" appeared
// at the start and end). This hook denies such commands so the mistake can't ship.
//
// Reads the PreToolUse JSON payload on stdin, inspects ONLY tool_input.command (so the
// hook never false-triggers on a tool description that happens to mention @'...'@).

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let command = "";
  try {
    const payload = JSON.parse(raw);
    command =
      (payload && payload.tool_input && payload.tool_input.command) || "";
  } catch {
    process.exit(0); // Unparseable input: fail open, never block on hook error.
  }

  // PowerShell here-string opens with @' and closes with '@. Both present => misuse.
  if (command.includes("@'") && command.includes("'@")) {
    const reason =
      "PowerShell here-string @'...'@ does not work in the Bash tool " +
      "(bash treats the @ as literal, corrupting the argument). " +
      "Use `git commit -F <file>` / `gh ... --body-file <file>` with a " +
      "Write-created temp file, or a bash heredoc, instead.";
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
  }
  process.exit(0);
});
