/**
 * Refuse any shell command that writes to .env.
 *
 * .env holds the owner's real credentials — Turso, Azure, Telnyx, Anthropic —
 * and it is theirs to edit, not ours. Only .env.example is ours to write.
 *
 * The permission rules in .claude/settings.json already stop the Write and Edit
 * tools. This closes the other door: a shell redirect, a `cp .env.example .env`
 * or a `sed -i` would otherwise sail straight past those rules.
 *
 * Node, not bash+jq: jq is NOT installed on this machine, and the first version
 * of this hook used it. Every command parsed as empty and the guard allowed
 * everything, silently. A check that cannot fire is not a check — the same
 * lesson as the confidence score that was always 1.0.
 *
 * Deliberately narrow. Reading .env is fine (diagnosing a bad key needs it) and
 * .env.example is fine. Only writes to .env itself are refused.
 */

/** ".env" but NOT ".env.example" — the next character must not continue the name. */
const ENV_FILE = String.raw`\.env($|[^.A-Za-z0-9_-])`;

const RULES = [
  // > .env    >> .env    >"$root/.env"
  [new RegExp(String.raw`>>?\s*["']?[^\s"';|&<>]*${ENV_FILE}`), 'shell redirect'],
  // cp/mv/tee/rm/Set-Content/... with .env as an argument
  [
    new RegExp(
      String.raw`(^|[\s;&|])(cp|copy|mv|move|tee|truncate|rm|del|erase|install|` +
        String.raw`Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|` +
        String.raw`Clear-Content|New-Item)(\s[^;&|]*)?${ENV_FILE}`,
      'i',
    ),
    'file-writing command',
  ],
  // sed -i 's/.../.../' .env
  [new RegExp(String.raw`sed(\s[^;&|]*)?\s-i[^;&|]*${ENV_FILE}`), 'sed -i'],
];

function deny(why) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Refused: this command writes to .env (${why}). .env belongs to the user and ` +
          `Claude must never write, overwrite or regenerate it — write .env.example ` +
          `instead, or ask them to edit .env themselves. ` +
          `Guard: .claude/hooks/protect-env.mjs`,
      },
    }),
  );
  process.exit(0);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let command = '';
  try {
    command = JSON.parse(raw)?.tool_input?.command ?? '';
  } catch {
    // Unparseable input. Fail closed only when the payload mentions .env at all,
    // so a malformed hook envelope cannot become a way past the guard — while
    // still not blocking every unrelated command on a parser hiccup.
    if (new RegExp(ENV_FILE).test(raw)) deny('unparseable input mentioning .env');
    process.exit(0);
  }

  for (const [pattern, why] of RULES) {
    if (pattern.test(command)) deny(why);
  }
  process.exit(0);
});
