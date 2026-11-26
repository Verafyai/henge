# Prompt Guard, vendored

Source: https://github.com/Verafyai/prompt-guard at commit `caae11c94d842ea6e269315ff786afd668131349`
(2026-11-10, upstream version 0.1.0, MIT). Upstream has no release tags, so the pin is the commit.

`vendor/` holds the upstream files byte for byte: `src/`, its test, `LICENSE`, `SPEC.md` and `package.json`.
`vendor/PIN.json` records each file's SHA-256, and `pnpm test` fails if any file changes. Henge never edits vendored
files; fixes go upstream first.

To update: pick a new upstream commit, copy the same files from it, rewrite `PIN.json` with the new commit and
hashes, run `pnpm --filter @swarm-explorer/prompt-guard test` and the sandbox tests, and record the change in
`docs/DECISIONS.md`.
