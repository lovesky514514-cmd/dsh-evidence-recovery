# Agent development rules — SKY Evidence Recovery

Read `README.md`, `DSH_PLUGIN_CODE_STANDARDS.md`, and `docs/SECURITY.md` before changing files.

- Work only in this plugin checkout unless the user explicitly authorizes changes elsewhere.
- Never push, publish, open a PR, or modify a live DSH profile without explicit user authorization. Never access real business systems for tests.
- Preserve existing safety behavior; an unknown side-effect outcome must never trigger an automatic retry.
- Treat upstream DSH tool result metadata as untrusted until its origin is independently proven.
- Keep legacy metadata-only releases blocked until a trusted operator reconciles them.
- Protect the operator-only reconciliation path; do not equate "no registered admin tool" with OS isolation.
- Keep the demo launcher in preflight mode by default. Web requires a verified Agent isolation boundary.
- Prefer plain JavaScript/TypeScript and Node built-ins for the Cordis plugin.
- Add Python, Go, Rust, or Java only if a measured benefit outweighs installation and maintenance costs.
- Simplify code without changing semantics; extract helpers only for real duplication or clear responsibilities.
- Use short, meaningful ENGLISH source-code comments for non-obvious decisions and invariants.
- Do not narrate obvious lines. No long file headers, changelog essays in code, or decorative separators.
- Keep ordinary source lines at or below 120 characters; avoid long nested expressions and one-line try/catch chains.
- Do not add decorative separator runs, especially nine consecutive equals signs or eleven hyphens.
- Do not hardcode personal information, local absolute paths, credentials, tokens, or deployment-specific directories.
- Keep the Apache-2.0 license. Do not paste copyrighted third-party implementation code.
- Maintain a single `问题与修复记录.md` for discovered defects, their fixes, and evidence.
- Always distinguish simulated tests, real DSH runtime tests, Web/model tool calls, and unsupported platforms.
- Complete the work and run tests in the current task; do not require repeated "continue" prompts.
- If a test cannot run, state exactly what is missing. Never fabricate a PASS or an execution trace.
- Do not delete or reset `.active.lock` to make a test pass unless in a clearly isolated disposable test directory.
- If a safe design requires a DSH host change, leave the plugin fail-closed and document the host-level gap.
