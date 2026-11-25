# Decisions log

## M0, November 24, 2026

### Pinned versions (SPEC 19A.1)
Checked against the npm registry on November 24, 2026 and pinned exactly (`save-exact`).

| Package | Version | Note |
|---|---|---|
| Node | 22+ (dev machine 26.10) | CI uses 22 |
| pnpm | 10.34.9 | pnpm 12.23.0 ships a native binary that macOS killed on launch on the dev machine; 10.x is the JS build |
| turbo | 2.11.13 | |
| typescript | 6.0.3 | 7.0 (native compiler) skipped until Next.js tooling supports it |
| next | 16.4.6 | App Router, Turbopack build |
| react / react-dom | 19.3.1 | |
| tailwindcss, @tailwindcss/postcss | 4.3.5 | Tailwind v4: the "preset" is a CSS `@theme` file, `packages/config/verafy.css` |
| drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 | |
| @electric-sql/pglite | 0.6.0 | embedded Postgres for zero setup local dev |
| vitest | 5.1.1 | |
| @playwright/test | 1.65.1 | |
| eslint | 9.x + typescript-eslint 8 | eslint 10 skipped until plugin ecosystem catches up |

### Choices
- **Local database.** `DATABASE_URL` unset means an embedded PGlite database at `.data/pglite`. Set `DATABASE_URL` for Neon or local Postgres (node-postgres driver). Same Drizzle schema and migrations for both.
- **citext.** SPEC asks for citext columns. We use `text` plus unique indexes on `lower(...)` so PGlite and Neon behave the same without an extension.
- **Stage deadlines.** SPEC 19A.2 takes precedence over 7.2: `stages` has `funding_deadline_at` and `build_deadline_at` (no single `deadline_at`), plus `minimum_executable_budget_cents`, `max_build_spend_cents`, `reserve_cents` and `spending_plan`. Stage status adds `settling` and `paused` (19A.3).
- **project_members** was pulled forward from M2 so moderators are real rows, not config.
- **projects.stats_cached** is a denormalized counter cache (backers, nodes, merged PRs, 7 day deltas) used for cards and the Trending score until contributions, nodes and pull_requests tables land. Seed fills it with example numbers.
- **Trending decay.** SPEC 6.1 says "decayed" without a formula. We divide the raw score by `sqrt(1 + age_days / 30)`.
- **Chip colors** follow the mockups' tint levels (for example amber-800 text on amber-50), which pass WCAG 2.2 AA. SPEC 2.2's amber-600 is used for dots only.
- **Escrow wording.** Per 19A.2 the trust box says "Stage funds held by the platform", never "escrow".
- **Seal badge** copy follows 19A.4: "Hash-chain record" for the pg chain, "Pending anchor" until a real ASC anchor verifies.
- **Example art and data.** Covers, waves and logo come from `docs/mockups/assets`. The 13 seed projects and their numbers come from `home.png` and `project.png`.
- **Mockup copy overridden by 19A** (19A says it wins over mockups): "Escrowed" becomes "Stage funds held"; "sealed on the Verafy chain" becomes "recorded in a public, hash-chained log"; ruling rows marked "Sealed" are not shown until rulings and seals exist.
- **Signed out header.** The mockups show a signed in header (credits pill, avatar). There is no auth until the next milestones, so the header shows Log in; the signed in variant exists in `Header` behind the `user` prop.
- **Default home grid** skips projects already shown in Featured and Recommended, which is how `home.png` reads. Any filter or sort shows everything.
- **Empty states** replace the mockup's governor feed, top contributors and forum threads on the project page until those tables exist.
- **Shared UI is framework agnostic** (plain `<a>`, no `next/*` imports) so the Electron client from the addendum can reuse it.
- **apps/storefront** instead of `apps/web`: the client-first addendum renames it, and the rename was done up front to avoid churn.

### Open items
- Visual baselines (`apps/storefront/e2e/*-snapshots`) are our render checked by eye against `home.png` and `project.png`; they guard against regressions, they are not a pixel diff against the mockup PNGs.
- Sentry is not wired (no DSN, no SDK yet). `SENTRY_DSN` is reserved in `.env.example`.

## Addendum M0 (client-first foundation)

### Pinned versions
| Package | Version | Note |
|---|---|---|
| electron | 45.5.0 | current stable; re-pinned at M1 if a newer stable ships |
| electron-vite | 6.0.0 | main, preload and renderer builds |
| vite / @vitejs/plugin-react | 8.3.8 / 6.3.0 | |
| @tailwindcss/vite | 4.3.5 | same Verafy `@theme` preset as the storefront |
| @tanstack/react-query | 5.108.4 | |
| zod | 4.6.7 | shared API contracts |
| @fontsource-variable/inter, jetbrains-mono | 5.3.0 | fonts bundled in the app; the client never loads remote assets |

### Choices
- **`packages/api-client`** holds the Zod contracts for `/api/v1` and a typed fetch client. The storefront validates
  what it sends with the same schemas, and the client validates what it receives, so drift fails loudly.
- **Route skeleton.** `/api/v1/health`, `/projects`, `/projects/featured` and `/projects/:slug` are live. Every other
  endpoint from SPEC 12 and ADDENDUM A7.2 is routed and answers `501 not_implemented` naming its milestone
  (`apps/storefront/lib/api-plan.ts`). Unknown paths answer 404.
- **CORS.** Public `/api/v1` reads send `Access-Control-Allow-Origin: *` with no credentials. Bearer-token endpoints
  in M1 get an origin allowlist (`app://swarmstarter`, the dev server) and preflight handling.
- **Renderer origin.** Production loads the UI from a privileged `app://swarmstarter` scheme served by the main
  process with path traversal checks and a strict CSP header, not from `file://`. Dev loads the Vite server with
  a relaxed CSP (inline scripts for React refresh, `ws:` for HMR).
- **Hardening already in M0** (A4.1): sandbox, context isolation, no Node in renderers, a two-method typed bridge,
  IPC sender checks, navigation and `window.open` blocked except allowlisted https hosts opened in the system
  browser, all permission requests denied, single instance lock. Fuses, signing and the payment window land in M1.
- **webPreferences test** reads `webContents.getLastWebPreferences()`, which Electron 45 has at runtime but does not
  declare in its typings. If it ever disappears the test throws and fails; it never skips.
- **Component stories** are rendered inside the Electron renderer ("View component stories") instead of adding
  Storybook. That proves the shared UI works in the client, and the Electron e2e asserts each story renders.
- **`cardTime`** moved to `@swarmstarter/core` so the storefront, client and CLI share one countdown rule.
- **StatusBar** restyled to the dark bar in `client-store.png` (it had no users yet).
- **CLI** (`apps/cli`) lists and shows projects over the API client; `login` and `node` exit with code 3 until
  their milestones. **Mobile** (`apps/mobile`) is a README placeholder only.
- **Certificates.** `docs/CERTIFICATES.md` is the procurement checklist; nothing has been ordered.

### Open items
- CI has not run on GitHub yet: this folder is not a git repository. The Windows Electron e2e job is written but
  has only been run on macOS locally.
- `apps/client` builds unsigned output only (`out/`); no packaging (electron-builder) until M1. (Done in M1.)

## Addendum M1 (client shell, auth, updates)

### Pinned versions
- electron-builder 26.18.1 (newest release at least two weeks old). `electron-winstaller` build scripts stay
  disabled: packaging targets zip, not Squirrel installers.

### Choices
- **Opaque tokens, hashed at rest.** Access (`ssa_`, 15 minutes), refresh (`ssr_`), code (`ssc_`) and web session
  (`sss_`) tokens are random strings; the database stores only SHA-256 hashes. No JWTs, so revocation is a row update.
- **Authorization code with PKCE (S256) through the system browser**, redirect to `http://127.0.0.1:{port}/callback`
  (RFC 8252, any port) with `swarmstarter://auth/callback` as fallback. The authorization code is consumed atomically
  (`UPDATE … WHERE used_at IS NULL RETURNING`).
- **The install is created at code exchange.** Each sign in creates a `client_installs` row holding the device's
  ed25519 public key. Refresh requires a device signature over `refresh.{install_id}.{timestamp}` (five minute skew),
  so a stolen refresh token alone is useless. `POST /api/v1/client-installs` is a heartbeat (version, channel).
- **Refresh rotation with reuse detection.** Presenting a rotated refresh token revokes the whole install and all its
  tokens. Signing out revokes server side and clears the keychain.
- **Tokens live in the main process only.** The renderer never sees a token; it asks the main process over named IPC
  calls, which make authenticated requests. The refresh token and device key are in the OS keychain
  (`@napi-rs/keyring`); the access token is memory only. The e2e scans the whole profile directory for token strings.
- **Encrypted cache, row level.** AES-256-GCM per row over `node:sqlite` (built into Electron 45), HMAC'd keys, key
  derived with HKDF from a master key in the keychain. Chosen over SQLCipher to avoid a native module that must be
  rebuilt for both Node and Electron ABIs. Tampered rows read as missing.
- **Keychain services.** Packaged builds use `ai.verafy.swarmstarter`; unpackaged runs use
  `ai.verafy.swarmstarter.dev`, so a dev run never shares a session with an installed build and macOS never prompts
  (each binary reads only items it created). Tests use a throwaway service and read it from inside the Electron
  process for the same reason.
- **Dev sign in.** Real identity providers are not configured, so `/login` lists seeded example users when
  `DEV_SIGN_IN=1`, or when `NODE_ENV` is not production. It is never on when `VERCEL_ENV=production`. A seeded
  `demo` user (2,450 example credits) is the default.
- **Deep links** parse to an allowlisted route set with allowlisted query keys and only navigate. A link such as
  `/back?amount=500` opens nothing and never prefills a write. The OS protocol handler is registered only by
  packaged builds (or with `SWARMSTARTER_REGISTER_PROTOCOL=1`), so dev runs never take over `swarmstarter://`.
- **Signed update manifests.** The ed25519 signature covers the exact manifest string (no canonicalization step to
  get wrong). The client checks the pinned host `releases.swarmstarter.verafy.ai`, refuses downgrades unless the
  manifest is a signed rollback, and verifies sha256 and size before install. Staged rollout uses a sha256 bucket of
  install id and version. The dev channel follows Nightly.
- **Test key only.** `release:test` creates a per-machine TEST key in `.data/release-test` (gitignored).
  `package:nightly` bakes its public key and the local API URL into the build, packages an ad-hoc signed zip with
  fuses set, and records a test-signed manifest over the real zip in the local database. Nothing is uploaded.
- **Packaging.** Fuses: RunAsNode, NODE_OPTIONS and inspect arguments off; cookie encryption, embedded ASAR integrity
  and app-from-ASAR-only on. macOS uses an ad-hoc signature (`identity: '-'`): Apple silicon kills unsigned binaries
  and flipping fuses invalidates Electron's own signature. This is not a certificate and is not notarized.
- **Only `zod` and `@napi-rs/keyring` ship as runtime dependencies.** Everything else (React, the workspace packages)
  is bundled by Vite, so the ASAR holds the build output plus those two.
- **Crash reporting is local only** (`uploadToServer: false`) until a collector exists. Dumps stay in the profile.
- **`projects.tags`** (text array) added for the Store chips; seed data gives every example project tags.
- **The Back dialog** explains that backing opens with the Wallet milestone and states that nothing was charged.
  There is no payment path in this build.
- **Trailer** is a poster frame (the first screenshot) until media uploads exist.

### Open items
- The packaged Nightly was built and launched on macOS arm64 only. Windows and Linux packaging is configured but
  not yet run, and their keyring binaries are only installed on those platforms' CI runners.
- The packaged app cannot be driven by Playwright (inspect arguments are fused off); its e2e coverage is the
  unpackaged build. A smoke launch confirmed it starts, signs its cache key and opens the encrypted cache.
- No real artifact host: manifests point at `releases.swarmstarter.verafy.ai`, which does not exist yet, so an
  offered update cannot download. Install and relaunch are deferred to the milestone that sets up the host.
- CI still has not run on GitHub (not a git repository).
