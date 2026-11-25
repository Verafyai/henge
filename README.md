# Swarm Explorer

Verafy's app store for swarms. Install one node, connect a local model, and give its time to the causes you choose.
Nodes earn credits for verified work in funded swarms; volunteer swarms earn impact only.

Source of truth: `docs/SWARM-EXPLORER-SPEC.md`. Decisions: `docs/DECISIONS.md`. The SwarmStarter documents in
`docs/history/swarmstarter/` are historical only.

All swarms, models, accounts and numbers in the seed are example data. Nothing here is deployed, and no pricing is approved.

## Run it

```bash
pnpm install
pnpm db:reset          # migrate and seed an embedded PGlite DB in .data/pglite
pnpm dev               # website on http://localhost:3000 and the Electron client together
pnpm cli swarms        # CLI against the local API (run while pnpm dev is up)
pnpm cli validate packages/schema/fixtures/manifests/valid/challenge-vaults.yaml
```

On first launch the client opens Pick a cause and checks this computer (read-only). For a test run with fixture
hardware, set `SWARM_EXPLORER_HARDWARE_FIXTURE=windows-rtx-12gb` (unpackaged runs only; see
`packages/node-core/fixtures/hardware`).

Sign in from the client opens your browser. With no identity providers configured (and `DEV_SIGN_IN=1`), `/login`
lists the seeded example accounts. Your sign in is kept in the OS keychain (service `ai.verafy.swarmexplorer.dev`
for dev runs).

Updates are checked against a signed manifest. To try it locally, create the TEST key and an internal-channel row
(dev server stopped), then use Settings, Check for updates:

```bash
pnpm --filter @swarm-explorer/client release:test       # TEST key in .data/release-test, placeholder 0.2.0-internal.1
pnpm --filter @swarm-explorer/client package:internal   # optional: ad-hoc signed zip in apps/client/release
```

Both are local only. Nothing is uploaded, and production signing needs separate approval (`docs/CERTIFICATES.md`).

Stop the dev server before `pnpm db:reset` (PGlite allows one process at a time). To use Postgres instead, set
`DATABASE_URL` and run `pnpm db:migrate && pnpm db:seed`.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test     # all packages
pnpm build
pnpm e2e                                     # website suite, TEST release, then Electron suite
```

## Layout

```
apps/web             Next.js website (browse-only: swarms, swarm pages, models, download, sign in) and the /v1 API
apps/client          Electron client: Pick a cause first run, Store, swarm pages, Settings > Node; node
                     supervisor utility process; tray and menu Pause; PKCE sign in, keychain, device-signed
                     node requests, encrypted cache, swarmexplorer:// deep links (navigate only), signed updates
apps/cli             `swarm` CLI: swarms, show, validate; developer commands arrive in M11
packages/schema      Swarm manifest v1 (JSON Schema + invariants), harness bundle schema, canonical JSON,
                     Ed25519 publisher signatures, bundle digests, fixtures
packages/sandbox     Harness sandbox: wasm host with limits, egress policy, scratch, capability tokens,
                     local model proxy, signed bundle checks, hostile-harness self-checks
packages/node-core   Hardware and runtime detection (read-only, injectable), Local preselection, run rules and
                     enforcement support, minimized capability reports, hardware fixtures
packages/api-client  Zod contracts for /v1 (catalog, node, task protocol, OAuth, device signatures), typed client
packages/db          Drizzle schema for SPEC 12 (append-only ledger trigger), migrations, seed, catalog queries
packages/core        Categories, availability and lease states, credit formatting, copy rules, can()
packages/ui          Verafy components and tokens (Header, Footer, Chip, Card, Tabs, StatusBar, ...)
packages/config      Tailwind v4 theme tokens, shared ESLint config
apps/mobile          Placeholder only; the companion is optional and not scheduled (SPEC 4.1)
```

Signing and release keys: `docs/CERTIFICATES.md`. Nothing is signed or published without Rex's approval.
