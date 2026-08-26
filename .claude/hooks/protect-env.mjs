/**
 * Refuse any shell command that destroys .env.
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
 *
 * --- what the second wipe taught us -------------------------------------
 *
 * Two commands used to walk straight past this guard, and both were verified
 * against a throwaway repo rather than reasoned about:
 *
 *   git clean -xdf        DELETES ignored files. -x is the whole point of the
 *                         flag, and .env is ignored. Verified: file GONE.
 *   git stash push --all  -a stashes IGNORED files too, so .env leaves the
 *                         working tree. Verified: file GONE.
 *
 * `git stash push -u` (--include-untracked) is deliberately NOT blocked: it
 * covers untracked files only and leaves ignored ones alone. Verified: file
 * intact. Blocking it would be superstition rather than protection.
 *
 * Read-only (`attrib +R`) is a partial defence and NOT a substitute for this
 * hook: it does stop `Set-Content` and a `>` redirect, and it does NOT stop
 * either git command above. Also verified, both directions.
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

  /**
   * git clean with -x (or -X): removes IGNORED files, which is exactly what
   * .env is. Verified to delete it. `git clean -fd` without -x is left alone.
   */
  [
    new RegExp(String.raw`(^|[\s;&|])git\s+clean\b[^;&|]*\s-[a-wyzA-WYZ]*[xX]`),
    'git clean -x removes ignored files, and .env is ignored',
  ],

  /**
   * git stash --all / -a: stashes ignored files, taking .env out of the
   * working tree. `--include-untracked` / `-u` does NOT and is allowed.
   */
  [
    new RegExp(String.raw`(^|[\s;&|])git\s+stash\b[^;&|]*(--all|\s-[a-zA-Z]*a\b)`),
    'git stash --all stashes ignored files, and .env is ignored',
  ],

  /** Restoring .env from git would replace the owner's file with nothing. */
  [
    new RegExp(String.raw`(^|[\s;&|])git\s+(checkout|restore)\b[^;&|]*${ENV_FILE}`),
    'git checkout/restore of .env',
  ],
];

function deny(why) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Refused: this command destroys .env (${why}). .env belongs to the user and ` +
          `Claude must never write, overwrite, delete or regenerate it — write .env.example ` +
          `instead, or ask them to edit .env themselves. ` +
          `Run "pnpm env:check" to confirm .env is intact. ` +
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
    const input = JSON.parse(raw);
    /**
     * Both shells, and any future one.
     *
     * The matcher in settings.json now covers PowerShell as well as Bash —
     * it used to say only "Bash", so every rule above was unreachable from
     * the PowerShell tool no matter how good the pattern was. Reading the
     * command generically here means a third shell tool cannot reopen that
     * hole by using a different field name.
     */
    const toolInput = input?.tool_input ?? {};
    command = toolInput.command ?? toolInput.script ?? toolInput.cmd ?? '';
    if (typeof command !== 'string') command = String(command ?? '');
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
