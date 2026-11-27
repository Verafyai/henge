# Henge decisions

Implementation decisions made while building from `docs/SWARM-EXPLORER-SPEC.md`. Items marked **Needs Rex** are open
business or hosting choices that the spec leaves unapproved; the code keeps them as configuration or placeholders.
SwarmStarter decisions are archived in `docs/history/swarmstarter/DECISIONS.md`.

## henge file v1 and Glyphs (2026-11-26)

Workstreams C and D (schemas only) of "Henge spin-out v2", in `packages/schema`. A Glyph is what other tools
call a plugin; a Rune is one of its settings. `ManifestV1` and its validator are unchanged.

- **Files:** `henge-v1.schema.json` (`$id` `https://henge.verafy.ai/schema/henge-v1.json`), `glyph-v1.schema.json`
  (the spec bundle's schema, unchanged), `henge-v1.ts` (types), `henge-validate.ts`, `glyph-validate.ts`,
  `henge-to-manifest.ts`, `henge-digest.ts`, `henge-resolve.ts`, `henge-archive.ts`, `henge-landing.ts`.
  The new `$id`s use `/schema/` (singular) as the spin-out spec says; the older manifest and harness schemas keep
  `/schemas/`.
- **Platform:** digest, archive extraction and resolution use Web Crypto and `DecompressionStream`, so everything
  is exported from the package index and no dependency was added. ZIP and tar are parsed by hand.
- **Strictness:** like ManifestV1, unknown fields are refused at every object level unless named `x-`. The shape
  follows `example.henge.yaml`, including fields the table does not list (`admission.review`, `capacity`, `leave`,
  `schedule.windows_example`, `runtime.temporal.ui`, channel `agents`).
- **Additions beyond the table:** optional `participation.models.class` (the `class` policy needs it) and optional
  `runtime.harness.hash` (ManifestV1 needs a harness digest). All six roles in `governance.roles` are required.
- **Static rules added beyond 6.4:** the scorer must live under `benchmarks/scorer/`; `governance.voting.glyph`
  must be an added Glyph; channel `glyph_posts` must name an added Glyph; channel and default roles must exist in
  `governance.roles`; compute ranges need min <= default <= max; the landing accent must reach WCAG AA for normal
  text (4.5:1) on `#050506`, as the example's comment says; every update must bump `version`; a declared
  `source.bundle_digest` must match the fetched bundle.
- **Rules that need more than one file** have their own functions: `validateHengeBundle` (executables, text-only
  strategies and learnings, bundle-local Glyphs), `checkHengeUpdate` (constitution, append-only learnings,
  re-consent, vote-required fields), `checkJoinReadiness` (required caps), `checkGlyphGrant` (7.3 vote rule).
- **Glyph manifests are looked up, not fetched:** `validateHenge` checks `glyphs[]` against manifests the caller
  passes (built-ins, the bundle's `glyphs/`). An entry with no manifest is listed in `unchecked` rather than failing.
- **Executables:** detected by extension, by magic bytes (ELF, PE, Mach-O, wasm, shebang) and by archive mode bits.
  This also refuses a code Glyph's wasm module inside a `.henge` bundle's `glyphs/` folder.
- **Re-consent paths:** `glyphs.add`, `glyphs.permissions` and `glyphs.runes` are views over `glyphs[]`. A path v1
  does not define falls back to its nearest existing parent (so `participation.limits` means all of
  `participation`). The previous and next versions' lists are combined, so removing a field from the list does not
  skip re-consent for that same change.
- **Vote-gated scopes:** `treasury:pay` and `moderate:ban` are checked when granted, not in the file, because the
  file does not know the member count. "Owner is the only member" is `memberCount === 1`; the caller confirms that
  member is the owner.
- **Extra scope checks:** a `network:` scope must be one lowercase domain (no IP or single label) and not a model
  provider domain, matching the 6.4 task network rule.
- **Runes:** `null` means unset and always fits. `percent` is a fraction from 0 to 1. `duration` is a non-negative
  number in the Rune's `unit`. `change_requires` defaults to `vote`; a cosmetic Rune skips the vote only when the
  caller says the Henge exempts cosmetic Runes (`no_vote_needed_for: glyphs.runes.cosmetic`).
- **Glyph `use` ranges:** exact, `^x.y.z` or `~x.y.z` only.
- **Digest (6.6):** besides `signatures`, the digest also leaves out `source.bundle_digest` and `source.commit`,
  because neither can be inside the content it describes. A single file is digested as a bundle holding only
  `henge.yaml`. Paths are sorted by UTF-16 code units, as in `canonical.ts`.
- **toManifestV1:** id `<publisher>/<swarm>` becomes `<publisher>--<swarm>`; `publisher` is the publisher slug;
  `api_allowed` is `byo_api_key`; `scratch_disk_gb` is the range max; `api_spend_daily_usd` is the daily cap default
  when the currency is USD; relative schema paths and the first leaderboard become https URLs from a caller base
  URL. Category, impact weight, funding, urgent tasks and a wasm harness hash have no `.henge` field and come from
  the caller; credits default to volunteer, urgent to false. The original id and version ride along as `x-henge`.
- **The example fails one existing invariant:** converted verbatim, `example.henge.yaml` fails
  `self_hosted_requires_url` and `self_hosted_requires_key` (self-hosted coordinator, both null). The fixture is
  kept as given; the test shows it passes with a hosted coordinator.
- **Resolver:** every hop is checked (https, no credentials, all DNS answers public, IANA special-purpose ranges
  refused), redirects are followed by hand (at most 5, loops detected). Tree URLs take the first segment after
  `tree/` as the ref, resolve it to a commit and walk the contents API; the whole folder is fetched, since the
  digest and the executable rule cover every file. GitHub requests are unauthenticated.
- **Sanitizer:** raw HTML is reduced to an allowlist of formatting tags and attributes; script, style, iframe,
  form and similar elements are dropped with their contents; links may be https, mailto, anchors or bundle paths;
  images must be bundle paths that exist. Code blocks are left as written.
- **Built-in Glyphs** (`fixtures/glyphs/verafy/`) are example manifests. Rune defaults come from the example
  files or are null; `benchmark_id` and `active_strategies` are null because they name one Henge's own items. See
  that folder's README.

**Needs Rex**

- `example.henge.yaml` uses a self-hosted coordinator with no url or key, which the existing invariants refuse.
  Should the example say `hosted`, or should `local_single_node` mode relax that rule?
- `participation.limits` (in `vote_required_for` and `member_reconsent_on`) names no field. Which fields does it
  mean? It is treated as all of `participation` for now.
- `glyphs.runes.cosmetic` and channel `agents: reply_in_threads_only`: allowed values not defined.
- Rune value formats: `duration` (number with unit, or text like `72h`?), and the full options for
  `benchmark.schedule` and `moderation.link_filter`.
- `inject:agent_context` counting against `learnings.max_context_tokens`, and "a Glyph never receives member API
  keys or messages outside its channels", are runtime rules; nothing in the schema enforces them yet.
- Code Glyphs inside a `.henge` bundle: the executable rule refuses their wasm. Allow them under `glyphs/`?
- Funding, category and impact weight have no `.henge` field, so ManifestV1 gets them from the caller. Should
  v1.1 add them (for example from the Treasury Glyph's Runes)?
- DNS rebinding: the injected fetch must connect to the address the lookup approved. A Node implementation that
  pins the socket is still to be written with the client.
- `runtime.harness.runtime: container` in the example, while decision 2026-11-25 says nodes run no containers.

## henge.verafy.ai landing (2026-11-26)

Workstream B2 of the "Henge spin-out v2" spec (section 5.2), branch `web/henge-landing`.

- **Hosting: option B.** Rex chose that henge.verafy.ai is served by this repo's `apps/web` (the spec's option B), not
  by testnet-demo. Nothing is deployed and no domain or DNS changed.
- **Routes.** `/` is the 5.2 landing page (sections 0 to 8). The Henge web store that used to be `/` moved to
  `/swarms` (search is `/swarms?q=`); the shared Header, Footer and Logo now link there. `/login`, `/models`,
  `/swarms/<slug>`, `/authorize` and every `/v1` route are unchanged. New: `/download`, `/spec`, `/glyphs`, `/s`.
  The app is split into route groups: `app/(henge)` (dark, Henge nav and footer) and `app/(web)` (light Henge web
  pages with the shared Header and Footer). The root layout only loads fonts.
- **Platform note:** Rex changed the hero note to "macOS first. Windows and Linux later. Not released yet."
  (the spec table said "Windows, macOS and Linux."). Everything else is the spec copy, exactly, in
  `apps/web/lib/henge-landing-copy.ts`; its test fails on U+2014, U+2013 and on any digit except 01 to 04 and the
  example snippet's `"1.0"` and `@^1`.
- **Hero and community images:** the client is not built, so both images are the spec mockups
  (`01-client-main.png`, `13-community-chat.png`, in `apps/web/public/henge/`), each with a visible
  "Design preview" label and a caption that the client is not built and that names and values are examples. They
  are hidden below 720px, as in the mobile mockup. Replace them with real screenshots once the client ships.
- **Fonts:** Chakra Petch 600/700 is added through `next/font/google` (self-hosted at build, like Inter and
  JetBrains Mono already were). No font CDN at runtime.
- **/download:** three disabled buttons (macOS "Not released yet", Windows and Linux "Later"), no links, no version
  or size. It links to GitHub Releases only once a release exists.
- **/spec:** spec sections 6 and 7 copied verbatim into `apps/web/content/henge-spec.md` and rendered by a small
  parser (`apps/web/lib/mini-markdown.ts`) into React elements, with no HTML injection and no new dependency.
- **/glyphs:** read-only list of the six built-in Glyphs from 7.1, with Runes labeled "Example Runes".
- **/s:** a disabled ".henge link" field and a "Coming soon" button; the resolver ships in its own PR.
- **Links:** "Start your own Henge" and "Read the .henge spec" go to `/spec`; nav "Docs" goes to `/spec`; the
  four other nav links are in-page anchors.
- **Needs Rex:**
  - Privacy and Terms: verafy-website has no Privacy or Terms route in code (they are CMS fields, and its
    `isPolicyUrl` rejects verafy.ai links), so the footer shows them as plain text, not links. Give the URLs.
  - "See the henge-bench plan": `Verafyai/henge-bench` does not exist yet (checked 2026-11-26), so the button shows
    "(Not published yet)" and links nowhere. Set `HENGE_BENCH_URL` once the repo exists. (`Verafyai/henge` is public,
    so the GitHub links work.)
  - The /spec page shows the spec's own headings ("6. Workstream C: ..."), which read as internal. Approve or
    supply public wording.

## Rex's finish-up brief (2026-11-25, later the same day)

Rex's "Henge: finish-up brief" orders the remaining work: Part A (verafy.ai copy), Part B (M5 to M7, stop at G1),
Part C (the Henge communities spec, a PR before any code) and Part D (questions for Rex). These calls govern over
anything below.

- **Identifiers are final:** appId `ai.verafy.henge`, URL scheme `henge://`, keychain service `ai.verafy.henge`
  (`ai.verafy.henge.dev` for unpackaged runs), app origin `app://henge`. The code already used these; the M0 entry
  below that names `ai.verafy.swarmexplorer` and `swarmexplorer://` is superseded. `apps/client/src/main/identifiers.test.ts`
  fails if the builder config, the keychain default, the scheme or the origin drift apart. This must not change after
  signing.
- **Henge web:** the web view of the swarms is **Henge web**, not Swarm Explorer, because Swarm Explorer is already a
  live Verafy product at swarm.verafy.ai. That product is untouched. The internal `@swarm-explorer/*` package scope
  and the `SWARM_EXPLORER_*` environment variables stay. JSON Schema `$id`s move to `https://henge.verafy.ai/schemas/`.
- **Domain:** Henge web lives at **henge.verafy.ai** (store, sign-in and the `/v1` API). Staging is a Vercel preview of
  the same project. The website's Install, Browse Henges and download links move to Henge web once staging exists.
- **Website claims (Part A, verafy-website #83):** the site says macOS first with Windows and Linux later, API keys
  later, earning after a short trial, a 20% platform fee, "No member owns it" and "Verafy runs the court and publishes
  how every jury is drawn". A site test (`HENGE_RELEASE`) mirrors this file: API mode off, Mac only. Change both
  together.
- **Mac alpha:** approved. The site's install button becomes "Join the Mac alpha": it signs in with the existing
  Verafy account and stores the account id, platform and time. Nothing else. It gives way to the real download when
  M7 ships a notarized build.
- **Lineage:** the "Find a genealogy Henge" button stays removed until Lineage has a public site.
- **Prompt Guard screening is decided** (see the 2026-11-25 Prompt Guard bullet below): the M6 "Screening (Needs Rex)"
  entry is closed. `heuristic-v1` stays only until the vendored Prompt Guard lands in M7.
- **Henge communities** (Constitution, Conclave, Judiciary, Treasury, founding a Henge) get their own spec,
  `docs/HENGE-COMMUNITIES-SPEC.md`, reviewed by Rex before code. Its milestones C1 to C3 start after M7; C4 (Treasury
  and paid access in dollars) waits for G2 and legal sign-off. This replaces the "after G2" note below.
- **E2E databases:** each Playwright suite resets its own PGlite directory before it starts (Verafyai/henge #2).

## Rex's decisions (2026-11-25)

These settle the open items from M0 to M3. Where an earlier section below says **Needs Rex**, this section governs.

- **Hosting:** website and API on Vercel, Postgres on Neon, desktop builds on GitHub Releases under Verafyai.
  Nothing is deployed yet. A staging environment is stood up during M5 so real nodes can lease tasks remotely.
  Production comes at M7.
- **Pricing:** 1 credit = $0.01 with a 20 percent take rate, approved as economic config v1. Revisit at G2 with the
  first paying publisher.
- **API mode:** off for the first release; the alpha is Local only. Provider terms reviews happen before M8,
  OpenRouter first.
- **WebAssembly engine:** Node's built-in WebAssembly with wall-clock limits is accepted for the alpha, as a known
  deviation from SPEC 11.3 (Wasmtime). **Before G3:** add metering that counts work done (an instrumentation pass
  at load time), so the security review sees real CPU limits.
- **Container harnesses:** no Linux VM in v1. `lean-prover` is restructured so nodes only run models and return
  candidate proofs as text; Lean checking moves to the coordinator as the swarm's machine-check verifier. Nodes
  run no containers at all.
- **Model catalog:** a script pulls real digests and sizes from Ollama registry manifests. Curate 4 to 6 models
  covering 8, 16 and 24 GB machines, with licenses that allow this use. Rex approves the final list.
- **Speed labels:** no "Runs well" or "Runs slowly". The UI shows only facts: whether the model fits in memory, and
  the measured tokens per second from this machine's benchmark. Benchmark data is collected during the alpha;
  thresholds come later.
- **Prompt Guard:** the stand-in screener is replaced by the real Prompt Guard from `Verafyai/prompt-guard`,
  vendored at a pinned version (zero dependencies, Node 22). It must be in before M7.
- **License endpoint:** `POST /v1/me/license-acceptances` is approved and added to the SPEC 13.1 table.
- **Spec open questions:**
  - Private swarms are part of the same product: a private flag plus an invite list, with per-seat billing later.
  - Rex reviews every swarm until open publishing at M12; only curated publishers can submit before then.
- **Signing:** the alpha is Mac only. Apple Developer ID and notarization are approved. Windows signing waits for a
  Windows build.
- **Engineering gaps:**
  - llama.cpp serving lands in M5, Ollama first.
  - Scratch cleanup is wired in M4.
  - The disk budget stays on the device; it is a machine setting.
  - The installer is rebuilt at the end of M4.
- **Repository and CI:** the folder is a git repo pushed to a private Verafyai repository. CI runs on macOS only;
  Windows and Linux jobs come back when those builds exist.
- **Spec:** the current spec is "Swarm Explorer: product spec" (`docs/SWARM-EXPLORER-SPEC.md`). There is no newer
  addendum.
- **Name:** the desktop app is **Henge by Verafy**. The web view of the swarms is **Henge web** (renamed in the
  finish-up brief above). The app name and bundle ID are settled before code signing.
  - Henge community features (constitutions, treasuries, the judiciary) are not part of M4 to M7; they come after
    G2.

## M0 Foundation (2026-11-24)

### Repository
- Evolved the SwarmStarter monorepo in place rather than starting a new folder, so the carried-forward pieces
  (SPEC 18.1: Electron hardening, PKCE plus loopback, keychain, encrypted cache, signed update manifests, fuses)
  keep their tests. A snapshot of the previous state is in `.archive/swarmstarter-addendum-m1-2026-11-24.tar.gz`.
- Removed crowdfunding stages, constitutions, governance, treasury, USD money helpers, project pages, ProjectCard,
  StageSegments and SealBadge (SPEC 17.2, 18).
- Package scope `@swarm-explorer/`; `apps/storefront` is now `apps/web`.

### Manifests and bundles (SPEC 6)
- `packages/schema` holds two JSON Schemas: the SPEC 6.5 core schema verbatim, and the production v1 schema that
  adds every SPEC 6.4 field. Unknown fields are rejected unless prefixed `x-`.
- YAML is parsed strictly: core schema, unique keys, no aliases or merge keys, unknown tags and warnings are errors,
  256 KB limit.
- Cross-field rules (funded needs pool and reward, volunteer has neither, diverse needs panel rules and a jury,
  healthcare needs sensitive data prohibited and public inputs, model-provider domains never in `network`, and so
  on) live in `invariants.ts`. Two rules I first drafted (`parallel_requires_api`, `class_without_class_policy`)
  were removed because the spec does not state them (SPEC 17.3).
- Canonical JSON is RFC 8785. The signature payload is the manifest without `signatures`. Digests use the
  `sha256-<hex>` form; the `sha256:` form is accepted on input and normalized.
- Harness bundle digest = sha256 of canonical `{bundle_index_version:1, files:[{path,size,sha256}]}`. Symlinks and
  special files are refused.

### Seeds
- Three launch swarms from SPEC 16: Challenge Vaults (volunteer, Rex's manifest verbatim in
  `fixtures/manifests/source`), Verafy DAO juries (funded, 12 credits per accepted task, the spec's own
  illustration for "an accepted jury vote" in SPEC 2.1; not an approved price), Prompt Guard red team (volunteer). Every fixture carries an `x-example` note.
- The funded pool exists but is **empty**: no purchase is possible without approved pricing (SPEC 9.6A).
- Economic values (credit price, take rate) are stored only as an `economic_configs` row with status `proposal`.
  **Needs Rex**: approve or replace them before M9.
- Model artifact hashes are fixture digests, not real downloads, so the M2 hash check will block them by design. Superseded in M7: the seed now carries the five approved real pins.
- Each seed run makes a throwaway `verafy-local-test-*` publisher key and discards the private half.

### API (SPEC 13)
- Base path `/v1` with the `{error:{code,message,details}}` envelope. Built in M0: health, swarms, swarm detail,
  models, harness release metadata, revocation feed, plus the carried-forward OAuth, me, installs and client
  release routes.
- Every other SPEC 13 endpoint is routed and answers 501 naming its SPEC 16.4 milestone (`apps/web/lib/api-plan.ts`).
- JSON writes require an `Idempotency-Key` header. OAuth token, authorize and revoke are exempt (RFC 6749 clients
  do not send one; codes and refresh tokens are single use).
- The install heartbeat lives at `POST /v1/installs/heartbeat` for now. M1 aligns registration with
  `POST /v1/installs`.
- Acceptance rates show "not enough history" and outcomes are empty until real verified results exist (SPEC 4.2:
  never fake percentages).
- Token prefixes are `sxa_`, `sxr_`, `sxc_`, `sxs_` (access, refresh, code, web session). I avoided `se*` because
  `ser_` occurs inside ordinary words (`user_`, `browser_`) and made the leak scan flag Chromium files.

### Website (SPEC 4.1)
- Browse-only: home (featured swarms, categories, how credits and impact work), swarm pages, models, download,
  sign in and consent. "Open in Swarm Explorer" uses `swarmexplorer://swarm/{id}`; there are no join, buy or back
  actions on the web.
- The download page offers nothing, because no signed public build exists.

### Desktop client
- Rebranded: appId `ai.verafy.swarmexplorer`, scheme `swarmexplorer://`, keychain service
  `ai.verafy.swarmexplorer` (`.dev` for unpackaged runs), app origin `app://swarm-explorer`. **Superseded:** the
  identifiers are now `ai.verafy.henge`, `henge://` and `app://henge` (finish-up brief, top of this file).
- Deep links follow SPEC 4.4 exactly: `swarm`, `model`, `harness`, `result`, `join`, `publisher`, plus the auth
  callback. No link carries query parameters. `join` opens a review screen that cannot join. The legacy
  `swarmstarter://` scheme is **not** registered: the spec allows it only as a redirect after an approved
  migration mapping.
- The local "Library" of projects was removed; Library means joined swarms, which arrive in M4. Recently viewed
  swarms stay in the encrypted cache.
- Channels are stable, beta and internal (SPEC 15.1). Packaged local builds are internal; unpackaged runs report
  "dev" and follow internal.
- External links allowed: `www.verafy.ai` and `github.com` only.

### Hosting (**Needs Rex**)
- SPEC 2 says to confirm hosting before provisioning, so there is no production API or release host. Builds fall
  back to `http://localhost:3000`, and the update checker pins only `releases.swarm-explorer.test` (an RFC 6761
  reserved name) used by test releases.

### CLI
- The binary is `swarm`. M0 has `swarms`, `show` and `validate <manifest.yaml>`. `init`, `dev`, `verify`,
  `package` and `publish` exit 3 naming M11; `login` names M1 and `node` names M5.

## M7 Prompt Guard (2026-11-25)

- Prompt Guard from `Verafyai/prompt-guard` is vendored in `packages/prompt-guard` at commit `caae11c` (upstream
  0.1.0, MIT, no release tags, so the pin is the commit). Files are byte-identical to upstream; `vendor/PIN.json`
  holds their SHA-256 and the package test fails on any change. Updating is a documented copy and re-pin (VENDOR.md).
- `promptGuardScreener` (`packages/sandbox/src/prompt-guard.ts`) replaces `heuristic-v1` in the node supervisor and
  the sandbox self-checks. It scans every string in the task input and records each flagged rule with its JSON path.
  The screener name in every run record is `prompt-guard/1@caae11c`, so a verdict always says which guard made it.
- Flagged input still runs, as before: the sandbox's structural protections do not depend on the screen, and the
  verdict travels to verifiers and juries. Juries will use the guard's `compile` and `renderGuarded` on evidence
  (communities spec 5.7); that lands with the jury work, not here.
- `heuristic-v1` stays in `broker.ts` only for its existing unit tests.

## M1 Node shell and first run (2026-11-24)

### Process layout (SPEC 11.1, 11.2)
- The node supervisor is a separate Electron utility process (`src/supervisor`, built as `out/main/supervisor.js`).
  It receives only `PATH`, its data directory and test hooks, not the main process environment. It never loads the
  keychain module; the main process makes every authenticated call. Main validates every supervisor message
  with Zod and restarts the supervisor up to three times.
- The local model proxy and sandbox broker are M3. In M1 the supervisor does detection and owns the pause state.

### Detection (SPEC 5.1)
- `packages/node-core` holds the logic, with all OS access injected, so fixtures drive the tests. The real
  probes are read-only fixed commands with no shell: `system_profiler SPDisplaysDataType -json` on macOS,
  `Get-CimInstance Win32_VideoController` on Windows, and `nvidia-smi` on Linux.
- Every value has a confidence (measured, estimated or unknown). Windows `AdapterRAM` near the 32-bit cap is only
  an estimate. Linux GPUs without NVIDIA tools are reported as unknown rather than guessed.
- Ollama discovery calls only `GET /api/version` and `GET /api/tags`, and only on loopback. An `OLLAMA_HOST`
  pointing off the machine is refused. llama.cpp is found on `PATH` without running it; it has no model
  registry, so models come from a folder the user picks (M2).

### Local preselection (SPEC 3.1, 5.1, 5.4)
- Local is preselected for Apple Silicon, or for a discrete NVIDIA or AMD GPU whose measured memory is at least
  the smallest catalog artifact. I did not invent a VRAM threshold: when the catalog is offline, any measured
  dedicated memory counts. Machine-specific fit (Runs well, Runs slowly, Will not fit) is M2.
- Without a usable GPU, Local is not preselected but can still be chosen (CPU, slow). "Save and continue" stays
  disabled until the user picks a mode.
- API and Hybrid exist as options but are unavailable until a provider passes the terms review (SPEC 5.5, a flag
  per provider, all off). The main process refuses to save an unavailable mode even if the renderer asks.
- A cause whose accepted models are not in the catalog is a policy mismatch and cannot be saved.

### Run rules (SPEC 7.2)
- Defaults are exactly the spec's. Heavy-app pause has no stated default, so it starts off.
- Enforcement is shown per rule and per OS:
  - Idle and schedule are enforced everywhere.
  - Power is enforced on macOS and Windows.
  - Temperature is best effort on macOS (a coarse thermal state).
  - CPU load is best effort.
  - Metered network, GPU load and heavy-app signals are shown as "not available on this computer".
- Disk budget is not defaulted; it is set at the first model download (M2). `nodes.disk_budget_bytes` is
  nullable for that reason (migration 0002).

### Node API (SPEC 13, 13.1)
- `POST /v1/installs` records version, channel, platform and arch, and creates the install's node once. The node
  name is generic ("Mac node"), so no hostname leaves the device. The heartbeat route is gone.
- `PUT /v1/nodes/{id}/capabilities` accepts only the SPEC 12.1 columns. The schema is strict, RAM and VRAM are
  rounded down to GiB and free disk to 10 GiB, and no GPU or CPU model names are sent.
- Node requests are signed with the device key over `swarm-explorer-device-v1`, method, path and query,
  base64url SHA-256 of the body, timestamp and nonce. The server checks a ±5 minute skew, verifies the
  signature against the install's registered key and accepts each nonce once per install (`device_nonces`).
  A stolen access token alone cannot call node endpoints.
- Node writes replay by `Idempotency-Key` from `idempotency_records`. Reusing a key with a different body is a
  422.
- `node.report` policy: only the install that owns a node may report for it. Another account gets the same 404
  as a missing node.

### Pause (SPEC 4.1)
- Pause is in the status bar, the Node menu (Cmd/Ctrl+Shift+P), the tray menu and Settings > Node. Nothing runs
  yet; when leases exist (M5), Pause abandons them immediately.

### Test hooks
- Unpackaged runs honor `SWARM_EXPLORER_HARDWARE_FIXTURE` (one of the five fixtures in
  `packages/node-core/fixtures/hardware`) and `SWARM_EXPLORER_OLLAMA_HOST` (still loopback-only). Packaged
  builds ignore both and always probe the real machine.

### CLI
- `swarm login` (device code, SPEC 4.4) belongs with the headless node, so its placeholder now names M5.

## WebAssembly metering (2026-11-25)

Closes the "Before G3" item in Rex's decisions: the sandbox now counts work done, not only wall time.

- **Approach:** a load-time instrumentation pass, `packages/sandbox/src/meter.ts`, named `meter/1`. V8's
  WebAssembly in Node has no fuel or metering hook, so the broker rewrites every harness module before it runs.
  No new dependency.
- **Why instrumentation:** the count is a function of the module bytes and the path the code takes. Machine
  speed, V8 tiering, the clock and timer jitter play no part, so the same harness, input and host replies give
  the same fuel on every machine. Time or interrupt based limits cannot promise that.
- **Cost rules (`meter/1`):**
  - A charge is inserted at function entry and right after every `block`, `loop`, `if`, `else` and inner `end`.
  - Each charge is the number of original instructions up to and including the next of those instructions.
  - Every loop pass and every call therefore costs at least 1, so a module cannot spin or recurse for free.
  - A region is charged in full when it starts, even if a branch leaves it early.
- **Counter:** one added mutable i64 global, exported as `__swarm_meter_fuel`, which the host sets before
  `run`. The original function, global and memory indices do not change. A module that already exports that
  name is refused.
- **Supported code:** WebAssembly 1.0 plus sign extension, saturating truncation, multi-value blocks, reference
  types and bulk memory. Anything else (SIMD, threads, exceptions, tail calls, GC) is refused before it runs
  ("module cannot be metered"), so nothing runs unmetered.
- **Out of fuel:** the run ends with status `fuel_exhausted` and no output leaves the worker. The client
  abandons the lease unpaid (`local_failure`) and submits nothing.
- **Other limits stay:** wall time, the memory cap, the heap cap and the model-call limit work as before.
  Metering is in addition. When one of those ends a run from outside, fuel used is not known and is null.
- **Run record:**
  - Record version 2 adds `record_version: 2` and `metering: { meter, fuel_used, fuel_budget }`.
  - Records without `record_version` are version 1 and stay valid. Version 2 must carry `metering`, and
    `metering` needs version 2.
  - The signed message format is unchanged.
  - The record is kept whole in `run_records.record_json`, so there is no migration.
  - Verifiers can compare `fuel_used` between records with the same `meter`. It matches exactly only when the
    input and host replies match (for example a replay with recorded model replies).
  - A server from before this change rejects version 2 records (strict schema), so the server ships first.
- **Budget:** neither the harness limits (SPEC 6.1) nor the manifest (SPEC 6.4) has a fuel field, and no number
  is approved.
  - The config value `APPROVED_FUEL_BUDGET` is null.
  - With null, fuel is counted and recorded but limits nothing.
  - Tests and self-checks use explicit test budgets only.
- **Self-checks:** two new checks, so Settings shows 17.
  - `fuel-exhausted`: a runaway loop stops with `fuel_exhausted`.
  - `fuel-counted`: a counting module uses exactly 10039 fuel, worked out by hand from the cost rules.
- **Fixtures:** unchanged. Metering happens at load, so `harness.wasm` and the pinned hashes did not move.
- **Known limits of `meter/1`:**
  - A host function call counts as one instruction.
  - `memory.copy` and `memory.fill` count as one whatever their length; they are bounded by the memory cap.
  - Fuel is a count of instructions, not CPU time.
  - The instrumentation overhead has not been measured.
  - The engine is still V8, not Wasmtime; that deviation stands.
- **Needs Rex:**
  - The fuel budget value, and whether it is per harness or per swarm.
  - Whether it becomes a `harness.json` limit or a manifest field (either is a schema change), and how it
    relates to the existing `cpu_ms` limit.
  - Whether verifiers act on fuel differences (for example in redundancy groups). Today fuel is only recorded.

## M2 Local sources and model catalog (2026-11-25)

### Hash pinning (SPEC 5.4)
- Every catalog artifact has a `source_ref` (an Ollama tag, or `owner/repo@revision/file.gguf` on Hugging Face) and a
  pinned `content_hash` (migration 0003).
- **Ollama:** the pin is the manifest digest Ollama reports for the tag.
  - If the tag is already present with the pinned digest, it is used as is and marked as the user's own, so we never
    remove it.
  - If the tag is present with a different digest, it is refused as tag drift and never pulled over.
  - After a pull, a digest mismatch blocks the model and the pulled tag is deleted again.
- **GGUF:** the file streams to `<hash>.gguf.partial` while being hashed, and is renamed only when the SHA-256
  matches. A mismatch, or more bytes than the catalog size, deletes the partial file.
- Blocked artifacts are listed with the expected and actual hash. The main process re-checks the verified hash
  against the catalog even when the supervisor reports success.
- The server refuses a benchmark whose verified hash differs from the pin (409 `hash_mismatch`).
- Seeded hashes are fixture digests, so real downloads of the seed catalog are blocked by design until a real
  catalog is approved. The e2e stand-in Ollama returns the seeded digest for one model to show the success path.
  Superseded in M7: the seed carries the approved real pins, so real downloads of them verify.

### Fit (SPEC 5.4)
- **Before download**, fit is a memory-size comparison and nothing more:
  - fits in GPU or unified memory: Runs well (estimate);
  - fits only in system memory: Runs slowly (estimate);
  - neither: Will not fit, and Download is disabled.
- That makes no speed claim. The UI labels it an estimate, and `GET /v1/models/{id}/fit` computes the same thing
  from the node's minimized capability report.
- **After download**, the benchmark becomes the fit only against an approved row in `fit_calibrations`
  (per runtime and catalog version). **Needs Rex/calibration data:** none ship approved, because the spec forbids
  undocumented performance claims. Until then the tokens per second is recorded and the estimate stands, and the
  UI says so.
- The starter recommendation (SPEC 5.1 step 5) is the smallest model with the best estimated fit that the chosen
  cause accepts.

### Benchmark
- **Ollama:** a 64-token generate using Ollama's own eval timings.
- **llama.cpp:** `llama-bench -p 0 -n 64 -o json`. If `llama-bench` is not on PATH, no benchmark runs and the reason
  is shown.
- Results go to `POST /v1/nodes/{node_id}/models/{hash}/benchmark` and are stored in `node_models`. A result made
  while signed out is sent at the next sign in.

### Disk budget and eviction
- The budget is chosen in the first download dialog, with no default, and can be changed in Settings > Node.
  It must be at least 1 GB and no more than free disk plus models already downloaded.
- When a download would exceed it, the least recently used removable models are suggested. Each removal is the
  user's click.
- The active model is never suggested or removed; the guard sits in node-core, the main process and the UI.
  Leased models join that set in M5.
- Models the user already had in Ollama don't count against the budget and are never removed by us.
- The budget is kept locally for now. `nodes.disk_budget_bytes` has no SPEC 13 endpoint to set it.

### Licenses
- Downloading requires ticking acceptance of the listed license for that artifact version.
- Acceptance is recorded locally and on the server through `POST /v1/me/license-acceptances`. This endpoint is not
  in the SPEC 13 table; I added it to satisfy SPEC 5.4. The server refuses a license id other than the catalog's.
- License review gating for launch-swarm eligibility belongs with join (M4).

### Security
- The supervisor does all network and disk work for models: downloads, hashing and benchmarks run in the
  supervisor process, never in the renderer or with keychain access.
- The renderer can only ask for an artifact by slug and hash. Main re-reads the catalog from the API and enforces
  license, budget, fit and runtime presence itself.
- Ollama traffic stays on loopback. GGUF downloads go to `https://huggingface.co`; `SWARM_EXPLORER_HF_BASE`
  overrides that only in unpackaged test runs.
- GGUF files are re-hashed before use in M3, when the model proxy first loads them.

## M3 Sandbox, permissions and proxy (2026-11-25)

### Process layout (SPEC 11.1, 11.2)
- **Model proxy:** a third utility process, "Swarm Explorer model proxy" (`src/proxy`).
  - It listens on a Unix socket in a 0700 folder (named pipe on Windows), never on a TCP port. When the profile
    path is too long for a socket, it uses a per-profile temp folder, and stale sockets are cleared at start.
  - It answers only `POST /v1/complete`. Pull, delete and other runtime administration are not reachable through
    it, and a harness never learns the runtime address or model tag.
- **Capability key:** a session key generated by main and sent to the supervisor (which mints tokens) and the proxy
  (which verifies them) by message, never through the environment or disk.
  - Tokens are `sxk_`-prefixed HMAC tokens scoped to lease, model hash, class, maximum tokens, maximum cost and
    permissions hash, with an expiry. The proxy counts tokens used per capability.
- **Keychain:** the proxy does not use it yet. API mode stays off (SPEC 5.5); when it ships, provider keys load
  in the proxy only.

### Harness sandbox (SPEC 11.3), `packages/sandbox`
- **Engine (Needs Rex):** the spec names Wasmtime. Wasmtime has no maintained Node binding we can ship in Electron,
  so this build runs modules on V8's WebAssembly in a worker thread with an empty environment and V8 heap limits.
  The isolation contract is the same:
  - no ambient filesystem, network, clock, environment or processes;
  - only explicitly linked host functions;
  - one host-created memory with a hard maximum.
  - **Gap:** fuel and epoch interruption are replaced by a wall-time limit that terminates the worker (this works
    even in a tight loop). `cpu_ms` is therefore enforced only as a wall-time bound. Swapping in Wasmtime (for
    example as a small sidecar binary) would restore true fuel metering.
  - Deterministic fuel counting now exists through load-time instrumentation; see "WebAssembly metering
    (2026-11-25)".
- **Static checks before running:**
  - imports come only from `swarm`, and each host function needs its capability;
  - the module may not define its own memory or carry a start function;
  - it must export `run` and `alloc`.
- **Capabilities** are what the bundle declares, narrowed by the approved permissions: network only when the swarm
  lists domains, scratch only with a scratch allowance. Model completion is always linked for a joined swarm.
- **Host ABI:** `model_complete`, `net_fetch`, `scratch_read`, `scratch_write` and `log`, each taking a JSON request
  and returning a JSON reply. Calls are synchronous for the harness via a shared buffer, with replies capped at
  1 MB.
- **Limits:** wall time, model calls (the loop's `max_steps`), the memory cap and the heap cap each end the task
  with a named limit.
- **Container harnesses** are refused with `container_isolation_unavailable`. **Blocked:** they need a
  VM-backed Linux guest on macOS and Windows (SPEC 11.3), which this build does not ship. `lean-prover` is a
  container harness.

### Egress (SPEC 11.3)
- **URL rules:** HTTPS on port 443 only, exact listed domains (subdomains are not implied), and no IP literals,
  including decimal forms.
- **Addresses:** every resolved address must be public; private, loopback, link-local, CGNAT, multicast,
  unique-local, NAT64, 6to4 and mapped addresses are refused.
- **Connections** are pinned to the checked address, which defeats DNS rebinding.
- **Redirects** are re-checked hop by hop (at most 3), responses are capped at 4 MB, and only a few safe headers
  are passed through.

### Scratch (SPEC 11.3, 11.4)
- One 0700 folder per swarm with flat names (no folders, so no traversal), symlinks refused and a byte quota.
  `destroy()` removes it with the swarm (wired to leave in M4).

### Signed bundles (SPEC 6.1, 11.6)
- `verifyBundle` checks, in order:
  - the release is reviewed and not revoked, and its publisher key is active, not revoked and the publisher's;
  - the release signature verifies over `{publisher, name, version, bundle_hash}`;
  - the directory digest matches, and a tampered file or symlink is refused;
  - `harness.json` passes the strict JSON Schema, and its paths stay inside the bundle.
- `tools` must be empty: tools that affect files, network or keys need separate review (SPEC 11.5).

### Prompt injection (SPEC 11.5)
- **Fixed system prompt:** the signed bundle's system prompt is always the only system message; a harness that
  sends its own is refused.
- **Output schema:** output must be JSON matching the bundle's output schema, so an answer that adds fields
  is rejected.
- **Screening (decided 2026-11-25, Prompt Guard from M7):** task input is screened before model use and the verdict recorded. The screener is a
  labeled heuristic stand-in (`heuristic-v1`) until the Prompt Guard model runs as a host capability. Flagged
  input still runs, because the structural protections do not depend on the screen.

### Self-check
- Settings > Node > Sandbox runs 15 checks on the user's machine: 12 hostile harnesses, plus three checks against
  the live proxy (no capability, a forged one, and one completion from the active model capped at 8 tokens).
- The check modules are WebAssembly text in `check-wat.ts`, compiled by `pnpm --filter @swarm-explorer/sandbox
  build:checks`; a test keeps the binaries in sync.

### Models
- **GGUF re-hash:** the proxy re-hashes GGUF files before first use and refuses a changed file.
- **Stubbed:** serving GGUF through llama.cpp (starting `llama-server` under the proxy) arrives with task leasing
  (M5). Ollama models are served now.

## Staging sign in (2026-11-25)

- Rex: no example-account sign in on any reachable URL. `devSignInEnabled()` now returns false on every Vercel
  deployment (`VERCEL` or `VERCEL_ENV` set), even with `DEV_SIGN_IN=1`. Example accounts remain for local runs and e2e.
- Staging signs in with one real provider: a GitHub OAuth app (`/v1/auth/github`, `/v1/auth/github/callback`). It is
  off unless `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` are set. Only two GitHub accounts get in,
  pinned by numeric id: rexsaurus (77756242) and Verafyai (197112695). Anyone else gets 403 and no account is created.
- The GitHub access token is used once to read the user and never stored. State is a random value in an httpOnly,
  SameSite=Lax cookie scoped to `/v1/auth/github`, compared in constant time. `allow_signup=false`, scope `read:user`.
- The Vercel protection-bypass secret for test nodes (approved) lives only in the test node's environment, never in
  git.

## M4 Store, swarm pages, join, qualification and leave (2026-11-25)

### Swarm pages (SPEC 4.2)
- Henge and the website render the same six questions in source order from one shared helper,
  `packages/api-client/src/swarm-view.ts` (`swarmQuestions`), so both always say the same thing.
- **Store home** (`GET /v1/store/home`, device-signed) puts Your swarms first, then categories and featured swarms.
- **Labels:** an active membership says "Joined, no tasks yet" until task leasing exists (M5). No fit adjectives
  (decision 2026-11-25).

### Join and permissions (SPEC 3.2, 11.4)
- A join pins the swarm's reviewed manifest by hash. If the release changed while the user was reading, the
  server answers `release_changed` and nothing is joined.
- **Approving permissions** sends their exact `permissions_hash`. Main approves only a hash that Henge itself showed
  for review (`review_first` otherwise), so the renderer cannot approve permissions nobody saw.
- **Reconsent:** an approved release with a different permissions hash moves active members to
  `reconsent_required`. Joining or qualifying members restart as joining, with their grants revoked. Shares are
  kept while stopped. Henge shows the old and new permissions side by side and marks what changed.
- **Policy check:** the server decides which installed models a swarm's policy accepts. Henge keeps that list per
  membership.

### Qualification (SPEC 3.2)
- **Tables:** `qualification_tasks` and `qualification_attempts` (migration 0004). The seed has 3 known-answer
  tasks per swarm, matching each manifest's `qualification.tasks`.
- **Scoring:** an answer matches when the expected fields are equal under canonical JSON. Late answers and runs that
  end without valid output count as wrong. The outcome is decided as soon as it can no longer change. A failed round
  can be retried, and the message says how many answers matched.
- **Challenge Vaults:** known answers check `status` only until the coordinator's Lean machine-check lands (M6).
- **No credit:** qualification writes no ledger entries.
- **Running it:** qualification runs in the sandbox through the proxy with the user's own model, like real work. It
  respects Pause but is not limited by run rules.
- **Token cap:** Henge caps each model call at 2,048 tokens (`MAX_TOKENS_PER_CALL`) on top of the harness's
  own limit. This is an engineering safety cap, not a business value.

### Bundles
- **lean-prover:** restructured as a wasm harness with no network. It returns proof text, and the coordinator
  checks proofs (decision 2026-11-25).
- **Fixture harnesses:** the three fixture bundles now carry a real `harness.wasm` built by
  `pnpm --filter @swarm-explorer/sandbox build:fixtures`, with manifest hashes re-pinned.
- **Local bundle host (flag for Rex):** `GET /v1/harnesses/{name}/releases/{version}/bundle` serves fixture
  bundles as base64 JSON. It is not in the SPEC 13.1 table. It stands in for object storage, which comes with hosting
  in M5. It returns 404 if the digest does not match. Henge downloads bundles only from the API origin,
  re-verifies the digest and signature, and keeps each bundle in a folder named by its hash.
- **Signing key:** the harness release response now includes the signing key (id, public key, status), so Henge can
  verify a bundle offline against a key it has been told about.

### Leave (SPEC 3.2)
- **Order:** Henge aborts the local run first, then sends `DELETE /v1/memberships/{id}`. The server marks open leases
  abandoned, revokes grants and rebalances shares. Henge then deletes the swarm's scratch folder, and the bundle
  too if no other joined swarm uses it.
- **Offline:** if the server cannot be reached, the leave is queued and retried. Local cleanup happens immediately
  either way. Earned credits stay.

### Reviews
- `POST /v1/admin/reviews/{id}` (bearer, reviewer or admin role, Idempotency-Key) records a release review. An
  approval publishes the release and applies the reconsent rules above. This is the release review stub; the full
  queue UI is M9.
- **Dev-only route:** `POST /v1/dev/swarm-releases` exists only with `DEV_SIGN_IN=1` and the `x-dev-tool: 1` header.
  It publishes an example permission-changing release, approved by the seeded reviewer, so e2e can test reconsent.

### Stubbed in M4
- No real tasks yet: the coordinator and task leasing are M5.
- Per-swarm pause, pins and priority are shown as status only; editing them arrives with the scheduler (M5).

## M5 Task protocol and scheduler (2026-11-25)

### Coordinator (SPEC 7.3, 13.3)
- **Pull only:** nodes ask for work with device-signed requests (same `withNodeAuth` as the other node routes).
  The coordinator never connects to a node.
- **Tables:** migration 0005 adds `lease_rules`, `deadline_misses`, lease timestamps and renewal count,
  `tasks.input_json`, `results.output_json` and `results.disposition`, and one run record per lease. Inputs and
  outputs live in Postgres until object storage arrives with hosting.
- **Eligibility:** a lease needs an active, qualified membership on this node, a current permission grant, no kill
  switch or revocation, a wasm release, an installed model the swarm accepts and no other open local lease (local
  concurrency is 1). Tasks lease only to a membership whose release has the same harness and permissions hash.
- **Funding stub:** volunteer swarms lease with `reward.funded: false`. A funded swarm answers `pool_empty` or
  `paid_leasing_unavailable` until pool reservations land (TODO M9).
- **New endpoints:** `POST /v1/leases/{id}/start` (pins checked, Leased to Running, returns the input) and
  `GET /v1/leases/{id}/input` (running leases only). Both are added to the SPEC 13.3 table. The input URI in a lease
  is this lease-scoped, device-signed route.
- **Deadlines:** set by the server from the release's `task.timeout_s`. Expired leases requeue on the next
  coordinator call (`sweepExpiredLeases`). There is no background job yet.
- **Renewal:** allowed only when the swarm's `lease_rules.max_renewals` says so. It is null (no approved value),
  so every renewal is refused with `renewal_refused`. The node tries once when a fifth of the lease is left.
- **Missed deadlines:** counted per node, swarm and lease rule version in `deadline_misses`. The repeated-miss
  threshold is `lease_rules.repeated_miss_threshold`, null with no default (SPEC 7.3), so misses lower nothing yet.
- **Submit:** idempotent by lease id and output hash. The same hash returns the first result (`duplicate: true`).
  A different hash is `already_submitted`. A result after expiry or abandon is stored with disposition `late` or
  `after_abandon` and is never paid. The run record must be signed by the device key of the install holding the
  lease, over `swarm-explorer-run-record-v1\n` plus the canonical record.
- **Schema check:** the output is checked against the release's output schema when the server holds that bundle,
  and `schema_valid` is stored. Rejection for an invalid schema is part of verification (M6).
- **Abandon:** immediate, unpaid, requeued, idempotent. Abandoning a lease that never started is recorded as
  Running then Abandoned, since SPEC 7.3 has no Leased to Abandoned edge.
- **States:** M5 moves leases up to Submitted. Verifying, Pending, Settled, Rejected and Clawed back are M6.
- **Task upload:** `POST /v1/swarms/{slug}/tasks:batch` (bearer, the publisher's owner only, Idempotency-Key),
  idempotent by `coordinator_task_id`. Urgent tasks are refused unless the swarm allows them.
- **Seed:** 3 queued volunteer tasks for Prompt Guard red team and a v1 lease rule per swarm with null values.

### Timeshare (SPEC 7.1)
- **Shares:** basis points summing to 10,000 across qualified swarms. `normalizeShares` uses largest remainder.
  Joining gives equal shares unless the user customized them, in which case the new swarm starts at 0 and the
  Library asks "Share equally" or "Keep my shares". Leaving spreads the freed share in proportion.
  `PATCH /v1/nodes/{id}/shares` must name every qualified swarm.
- **Scheduler:** `FairShareScheduler` in node-core is start-time fair queueing. Each swarm's virtual time advances
  by time used divided by its share, and the eligible swarm furthest below its share goes next.
- **Lending:** a swarm with no tasks is skipped and keeps its share. When it has work again it re-enters at the
  current virtual time, so it does not burst to "repay" lent time. A 0 share swarm only borrows lent time.
- **Urgent:** urgent work goes first but is charged to its swarm. The time it ran ahead of its share shows as a
  deficit in Activity until the other swarms win it back.
- Scheduler state is per session and in memory.

### Run rules (SPEC 7.2)
- **Gate:** `evaluateRunRules` decides whether a lease may start and whether running work must stop. A stop
  abandons the task like Pause. CPU load only holds back new tasks, because the task adds load itself.
- **Idle:** `powerMonitor.getSystemIdleTime`, default 5 minutes. If idle time cannot be read, nothing runs.
- **Power:** `isOnBatteryPower` on macOS and Windows, enforced.
- **Temperature:** best effort on macOS only. It uses `getCurrentThermalState` and stops on serious or critical.
  It never claims degrees.
- **Load:** CPU load average, best effort, not available on Windows. GPU load cannot be read.
- **Not available:** metered networks and heavy app detection are not available on any platform. The rule shows
  as "Not available on this computer" and is never applied silently.
- **Notes:** every rule line carries a plain note saying what it really does on this computer.
- **Editing:** rules are edited in Settings and kept in the encrypted cache.
- **Test hook:** unpackaged runs may set `SWARM_EXPLORER_SENSOR_FIXTURE` to a JSON file read on every check.
  Packaged builds ignore it.

### Pause and the runner
- **Pause** (tray, app menu, status bar, Settings, Activity) stops the sandbox through the supervisor. The proxy
  sees the broker hang up and aborts the runtime call. Henge then sends a best-effort abandon and starts no new
  lease until Resume.
- **Other stops:** leave, sign out and run rule stops do the same. Sign out waits for the abandon before tokens
  are cleared.
- **Recovery:** leases left open by a previous session are abandoned on the next sign in.
- **Pin checks:** before running, the node checks the lease's swarm, harness and permissions hash, then the input
  hash after start.
- **Protected model:** the model of a running lease cannot be removed.
- **Intervals:** the runner checks rules every 2 seconds, skips a swarm with nothing to lease for 30 seconds and
  refreshes queue counts every 30 seconds. These are engineering intervals, not business values.

### Models
- **Ollama:** a task runs end to end through the proxy.
- **llama.cpp:** `llama-server` is the second source behind the same `CompletionSource` interface.
  - The proxy starts it for one GGUF file at a time, on 127.0.0.1 and a free port.
  - Its random API key goes in its environment, not on the command line.
  - Main resolves its absolute path from PATH, because the proxy runs with an empty PATH.
- Tests use fakes and download nothing.

### Stubbed in M5
- **Verification and rewards (M6):** results wait for verification. There is no reputation and no pending or
  settled credit, and volunteer work earns impact only.
- **Funded leasing (M9):** this waits for pool reservations.
- **Renewal and miss threshold:** these wait for Rex's values.
- **Expiry:** expired leases are swept when the coordinator is called, with no timer yet.

## M6 Verification, ledger and reputation (2026-11-25)

### States (SPEC 7.3, 8)
- **Pipeline:** Submitted, then Verifying once intake passes (output schema valid and the run record signature
  verifies against the install's device key), then Pending or Rejected, then Settled when the review window closes
  with no fraud found, or Clawed back if fraud is found while Pending. Settled is final.
- **Intake failures:** an invalid schema or a bad run record signature is Rejected at intake with a record. A
  result whose schema cannot be checked yet stays Submitted until it can.
- **Records:** every decision writes a `verification_records` row (method, verifier version, result hash,
  evidence hashes, outcome, rationale code, panel, signature), one per result and method. Coordinator decisions are
  signed with the coordinator key; worker decisions carry the worker's own signature over
  `swarm-explorer-verification-v1\n` plus the canonical payload.
- **Where it runs:** the results endpoint runs intake and the coordinator side methods right after submit. Wallet,
  results and verifier work reads run a lazy pass (intake, methods, settlement). There is no background job yet.
- **Migration 0006** adds verification rules, verifier keys and nonces, hidden known answers, ledger buckets, lease
  state timestamps, redundancy groups, a unique run record signature and impact revocation.

### Verifiers (SPEC 8.1), package `@swarm-explorer/verify`
- **One interface:** `Verifier<Input>` with `method`, `version` and `verify()`, keyed by the manifest's method.
  `verify` returns null when it cannot decide yet, and the subject stays in Verifying.
- **Machine check** runs in a separate verifier worker (`apps/verifier`). It polls `GET /v1/verifier/work` and
  posts signed records to `POST /v1/verifications`. Requests are signed with the worker's Ed25519 key over method,
  path, body hash, time and nonce, and each nonce is accepted once. The platform re-checks the key, the record
  signature, that the subject waits for this method and that the record names the stored output hash.
- **Lean:** the worker writes the pinned statement plus the candidate proof to a temp folder and runs `lean` or
  `lake env lean` with a wall-clock limit, a minimal environment and its own process group. Network is denied with
  `sandbox-exec` on macOS or `unshare --net` on Linux; with neither it does not check and leaves the result
  waiting. Before Lean runs it refuses sorry, admit, new axioms, other declarations, options, metaprograms,
  native_decide and any change to the statement. After, `#print axioms` must list only propext, Classical.choice
  and Quot.sound. Tests use a fake Lean; the real Lean test skips when Lean is not installed.
- **Challenge Vaults qualification** now waits for this check too. A matching status is not enough; the attempt
  waits (`check_status: awaiting`) until the worker accepts or rejects the proof, then the round is scored. The
  qualification lease answers 409 `qualification_checking` while answers wait.
- **Prompt Guard reproduction:** the worker re-runs the claimed attack against a pinned fixture target (a keyword
  guarded model in the Prompt Guard wasm harness, bundle hash checked on load). It is deterministic, has no
  network and does not use the PR #6 screener. Accepted only when the target's reply leaks its word.
- **Known answers:** publishers upload hidden expected outputs with tasks (`known_answer`), only for swarms that
  list the method. Leases look the same for known and ordinary tasks, and node-facing views never show rationale.
  A wrong known answer is Rejected, and that node's ordinary results then wait in Verifying for review.
- **Redundancy:** each task is uploaded as N replicas in one redundancy group. One account never leases two
  replicas of a group, so same-account nodes are never independent. Agreement is a strict majority of distinct
  accounts by canonical output hash; no majority rejects all. N is `verification_rules.redundancy_count`, null,
  and uploads are refused with `redundancy_unconfigured` until it is set.
- **Jury:** a `JuryAdapter` interface plus a fixture adapter. The submitter's account and node are excluded, one
  seat per account, and the panel needs `jury_panel_size` seats and the manifest's model family diversity. The
  panel size is null, so no jury rules yet. Real juries are later.
- **Publisher review:** results wait in Verifying; there is no review queue yet.

### Ledger (SPEC 9)
- **Double entry:** every movement is one transaction whose debits equal its credits, with an idempotency key.
  Buckets are pool available and reserved, account pending and settled, and platform issued (the only bucket
  allowed below zero). Other balances may never go negative.
- **Movements:** lease reserve and release, accept to pending, settle, and clawback (pending back to the pool).
  Accept, settle and clawback are idempotent per result, so a result is never paid twice.
- **Volunteer swarms create no credits.** Funding, reserving and accepting all refuse a volunteer swarm with
  `volunteer_swarm`, and tests prove the whole pipeline writes no ledger rows for volunteer work.
- **Funded path:** tested with a test-funded pool fixture (`fundPool`, test only) and leases made directly,
  because funded leasing stays off until M9. Without a reservation, an accepted funded result earns impact only.
- **Reconciliation:** `reconcileLedger` checks every transaction balances, the ledger sums to zero, no bucket is
  negative, pool caches match the entries and pending equals unsettled acceptances.
- **Impact** is recorded per accepted result in `impact_events` (units from the manifest's impact weight). It is
  pending until settled and revoked on clawback. It is never spendable and never becomes credits.
- No purchases, transfers or cash out were added.

### Reputation and anti-cheat
- **Events:** accepted, rejected, clawed back and repeated deadline miss, one per evidence reference. Scoring
  version `unit-v0` adds 1 or subtracts 1. It is a placeholder that nothing uses yet.
- **Deadline misses** count toward reputation only when `lease_rules.repeated_miss_threshold` is set. It stays
  null, so misses are counted but lower nothing.
- **Replays:** a run record signature can be used for one lease only (`run_record_replayed`). Worker request
  nonces are single use, and a second different verdict for the same subject is `already_verified`.
- **No self grading:** jurors never include the submitter's account or node.

### Review window and settlement
- `verification_rules.review_window_s` is null with no approved value. Pending work never settles while it is
  null. Tests and e2e set a short test window through the dev only `POST /v1/dev/verification-rules`.
- Every new rule is a new version row; the current version applies.

### New endpoints
- `GET /v1/verifier/work` and `POST /v1/verifications` (verifier signed), `GET /v1/wallet`, `GET /v1/ledger` and
  `GET /v1/me/results` (bearer), `POST /v1/admin/results/{id}/clawback` (reviewer or admin, Idempotency-Key), and
  dev only `POST /v1/dev/verification-rules`. Added to SPEC 13.3 and 13.4 and the api-client contracts.

### Client
- **Activity** lists recent results with the server's state (Submitted, Verifying, Pending, Settled, Rejected,
  Clawed back) and when each state was reached. **Wallet** shows impact always and credits only once the account
  has funded work. Volunteer work says it earns impact, not credits.
- The client e2e runs the verifier worker: the M5 demo task goes Submitted, Verifying, Pending, then Settled with
  a test window, and shows impact and no credits.

### Needs Rex
- **Worker hosting:** where the verifier worker runs and who holds its key. Nothing is provisioned.
- **Values:** review window, redundancy count N, jury panel size, known-answer rate and the repeated-miss
  threshold. All are null.
- **Reputation weights** and what reputation gates.
- **Coordinator key custody:** `COORDINATOR_VERIFIER_KEY` in production; dev uses an ephemeral key.
- **Real Prompt Guard target:** the pinned target is a fixture.
- **Real juries** and a publisher review queue.
- **IP range evidence** for independence is not implemented; independence is by account only.
- **Funded leasing and reservations** arrive with pools in M9.

## M7 Release readiness (2026-11-25)

### Catalog
- The seed catalog is the five pins from the approved 2026-11-25 proposal: Phi-4 Mini 3.8B, Qwen2.5 7B Instruct,
  Mistral NeMo 12B, Phi-4 14B and Mistral Small 24B, each an exact Ollama `q4_K_M` tag with its registry digest and
  size. No moving tags, no Granite.
- Context lengths are not in the proposal, so they are null and shown as "not recorded".
- The two test-only models (a GGUF stand-in and a too-large entry) are seeded only with `SEED_TEST_MODELS=1` on the
  embedded database, for the client e2e. They are labelled "Test only".

### Kill switch (SPEC 11.6)
- One signed feed: `revocations` rows gain `action` (`revoke` or `restore`), `signature`, actor and Idempotency-Key.
  Targets `platform` (`*`) and `swarm` (slug). The newest entry per target wins; `effective_at` only moves forward.
- Each entry is Ed25519 signed over `swarm-explorer-revocation-v1\n` plus RFC 8785 canonical JSON. The feed lists
  its signing keys (`platform_keys`). Old keys stay listed so old entries still verify.
- `POST /v1/admin/revocations`: platform admins only, Idempotency-Key per admin, refuses a second stop of the same
  target (`already_stopped`) or a restore with nothing stopped (`not_stopped`).
- A stop refuses new leases (`killed`, `swarm_killed`) and qualification, and cancels every open lease at once:
  abandoned with `cancel_reason = kill_switch`, the task requeued unpaid, the reservation released. A late start
  on a cancelled lease answers `lease_cancelled`.
- The node polls the feed every 15 s with a 10 s timeout, so a stop reaches an idle node within 60 s. A lease
  answer of `killed`, `swarm_killed` or `lease_cancelled` checks the feed at once.
- Entries count only if their signature verifies. Builds pin keys with `MAIN_VITE_REVOCATION_PUBKEYS`; without it
  the client trusts the keys the feed lists (signatures checked, trust root is the API host).
- Fail closed for new work: if the feed was not read in the last 60 s, no new lease or qualification starts. A
  running task is stopped by a verified stop, not by a missed poll.
- A stop aborts the running task and qualification, deletes the stopped swarm's cached harness (SPEC 15.2), and
  shows why in the status bar ("Stopped by Verafy") and on Activity, with the signed reason.
- Dev only `POST /v1/dev/kill-switch` (behind `devSignInEnabled()` and `x-dev-tool`) uses the same function as the
  seeded example admin, for the client e2e.

### Public results and receipts
- `GET /v1/swarms/{id}/results` and the page `/swarms/{id}/results` (linked from "What has it produced?") list
  only Settled, on time results: output hash, harness and model pins, the methods that accepted it, impact and
  settled time, plus counts (settled, pending, being verified, not accepted, impact settled). No inputs, outputs,
  nodes, accounts or credit amounts.
- `GET /v1/results/{id}` is built: public for settled results, 404 otherwise.
- Receipts (`packages/schema` `receipt.ts`): JSON Schema plus `signReceipt` and `verifyReceipt`. Signed over
  `swarm-explorer-receipt-v1\n` plus canonical JSON with a separate receipt key. The receipt names its signer
  key, so it verifies offline; `--keys` or `--fetch-keys` also checks that key is one of the platform's.
- A receipt holds result id and output hash, swarm, funded flag, release manifest hash, pins, accepting methods
  with verifier versions and key ids, the Submitted, Pending and Settled times, earned impact, and the
  contributor's account id. No node id.
- Volunteer receipts always have `credits: null` (enforced by the schema). Funded receipts show credits only from a
  real `settle` ledger entry.
- Issued once on first request and stored in `receipts`, so a downloaded receipt never changes.
- `GET /v1/me/results/{id}/receipt` (bearer, own results only) and `GET /v1/receipts/keys` (public).
- Client: settled results have "View receipt", checked in the main process against the published keys, and "Save
  receipt" to a file. CLI: `swarm receipt verify <file> [--keys <file> | --fetch-keys]`.

### Installer and test updates
- Identifiers stay `ai.verafy.henge` and `henge://`. Packages are ad-hoc or unsigned; nothing is notarized.
- `release:test` also writes the payload to `.data/release-test/files/<url path>`.
- The client can now download a verified update: bytes must match the signed size and sha256 before the file is
  staged in `userData/updates/<version>/`. Installing (OS signature check and swap) is not built, because it
  needs signed packages.
- The only pinned release host is still the reserved `releases.swarm-explorer.test`. Unpackaged runs may set
  `SWARM_EXPLORER_RELEASE_MIRROR` (local http only) to serve that host's files; the host pin and hash check are
  unchanged. No release host is approved.

### New endpoints and migration
- `POST /v1/admin/revocations`, `GET /v1/swarms/{id}/results`, `GET /v1/results/{id}`,
  `GET /v1/me/results/{id}/receipt`, `GET /v1/receipts/keys`, dev only `POST /v1/dev/kill-switch`. The feed adds
  `action`, `signature` and `keys`. Added to SPEC 13.1, 13.3 and 13.4 and the api-client contracts.
- Migration 0007: `platform_keys`, `receipts`, revocation columns, `leases.cancel_reason`, the `platform`
  revocation target, nullable `model_artifacts.context_length`.

### Needs Rex
- **Model classes:** Phi-4 14B is `code-7b-plus` and the other four are `jury-panel-member`. My assignment, not in
  the proposal.
- **Context lengths** for the five pins.
- **Platform key custody:** production revocation and receipt keys (`PLATFORM_REVOCATION_KEY`,
  `PLATFORM_RECEIPT_KEY`) and the pinned client keys (`MAIN_VITE_REVOCATION_PUBKEYS`). Dev uses throwaway keys.
- **Who may use the kill switch:** today any platform admin. A second approver or a break-glass process is open.
- **Receipt contents:** whether the contributor's account id belongs in a receipt that may be shared.
- **Release host** and production signing (Apple, Windows) before any real installer or update install.
- **Kill switch bound:** 60 s with 15 s polling is my choice. Shorter means more feed traffic.

## Desktop app is dark only (Rex, 2026-11-25)
- Henge SPEC 9.1: the app is dark only and matches the Henge pages on www.verafy.ai. There is no light mode.
- **How:** `apps/client/src/renderer/styles.css` overrides the shared Verafy preset for the desktop app alone.
  - The zinc scale is inverted, so existing utilities keep their meaning: 50 is the faintest fill, 500 is muted
    text and 900 is the strongest text.
  - Brand and accent move to Henge red.
  - Status tints become dark tints with light text.
  - Healthy and running dots use `--color-live` (green), because red would read as an error.
  - The window background is `#050506`, and `nativeTheme.themeSource = 'dark'`.
- **Shared tokens:** these keep today's values in `packages/config/verafy.css`, so the web app renders
  unchanged:
  - `surface` (replaces `bg-white`);
  - `bar*` and `toast` (surfaces that are dark in every theme);
  - `danger`;
  - `live`.
- The app header shows the Henge mark with "HENGE // by Verafy".
- **E2E databases (Rex, 2026-11-25):** each Playwright suite owns its database and resets it on every run.
  - The client suite uses `.data/pglite-e2e-client`. Its webServer step wipes, migrates and seeds it, publishes
    the test-signed update manifest (`release:test`), then starts the website.
  - The web suite does the same with `.data/pglite-e2e-web`.
  - Neither touches the dev database in `.data/pglite`, and neither reuses a running server. If port 3000 is
    busy, stop the dev server first.

## Staging test nodes (2026-11-25)

- The protection-bypass secret (approved by Rex) is read from `HENGE_VERCEL_BYPASS` in unpackaged runs only and sent
  as `x-vercel-protection-bypass` only to the API's own origin (`apps/client/src/main/staging-bypass.ts`). Packaged
  builds never read it, it is never in git or a build, and a plain-http API URL disables it.

## Temporal in the node (2026-11-26)

Rex decided on 2026-11-26 that durability lives inside the node (spin-out spec v2, 9.3). The coordinator still talks
to the node only through the M5 lease protocol, which is unchanged.

- **Engine:** Temporal, not the journal fallback. The TS SDK is pinned at exactly 1.25.0 (`@temporalio/worker`,
  `client`, `workflow`, `activity`, `common`). The worker runs in the Electron main process with a workflow bundle
  prebuilt at build time (`scripts/bundle-workflows.mts`, about 1.9 MB), so no webpack runs on users' machines.
- **Local server:** Temporal CLI v1.10.0 (Server 1.32.2, UI 2.56.1), license MIT (copied next to the binary).
  - It runs as `temporal server start-dev` on 127.0.0.1 only: gRPC on 7233, UI on 8233, news fetch off, SQLite
    file in `userData/temporal`, namespace `henge`.
  - It is supervised by the main process (`src/main/temporal/server.ts`). A pid file is kept, and a server left
    over from a crash is adopted only if that pid is alive, runs our binary, and the port answers. A recycled pid
    is never killed.
  - The binary is a build resource. `scripts/fetch-temporal.mts` downloads the release archive and checks it
    against the pins in `src/main/temporal/pin.ts` (sha256 and byte size per platform) before extracting. The
    darwin-arm64 archive is sha256 `40a76ef7d525e6195b083e4cd50b184cc3bb242fea7f8dda2b9a8698ecbb7379`,
    36,857,799 bytes; the binary inside is about 121 MB. electron-builder ships it through `extraResources`, and
    `@temporalio/**` is unpacked from asar for the native core bridge.
  - If the server or worker cannot start, the node falls back to the in-process engine (same steps, no
    durability), and the overview reports `engine: { name: 'in_process', status: 'failed' }`.
- **Payloads at rest:** every payload is encrypted with AES-256-GCM (`codec.ts`) under a key derived (HKDF) from
  the keychain-held cache key. Workflow ids are hashed, so the SQLite file names no task, swarm or Henge. Tests
  check the file for plain text.
- **Workflows** (`src/main/temporal/workflows.ts`):
  - `SwarmTaskWorkflow` runs lease, start, guard, run, seal and submit. On failure it abandons cleanly.
  - `JoinWorkflow` resolves and pins the `.henge` with the packages/schema resolver. It refuses without a daily
    cap when the file requires one, and waits for an `admitted` signal when admission is by request. It then
    starts `BundleUpdateWorkflow` as an abandoned child.
  - `BundleUpdateWorkflow` checks for updates every 6 hours. An update that changes a `member_reconsent_on`
    field holds that Henge (node paused with reason `reconsent`) until a `confirmReconsent(version)` signal; any
    other valid update applies at once. It continues as new once history passes 400 events.
- **Step limits:**
  - Short steps: 30 s each, 5 attempts.
  - Submit: 15 s each, 10 attempts.
  - Run: the swarm timeout plus 60 s, a 10 s heartbeat timeout, and 3 attempts. A heartbeat renews the lease
    once when a fifth of it is left.
  - A server answer of 5xx is retried; a 4xx is final.
- **Exactly once:**
  - The lease request key is derived from the workflow id, so a retried lease request returns the same lease.
  - The start and abandon keys derive from the lease id.
  - The result is sealed once in its own journaled step (output, hash, signed run record). Every submit attempt
    sends those exact bytes with `Idempotency-Key: henge-result-<lease id>`. The coordinator's existing
    idempotency layer replays the first answer (`idempotent-replay: true`).
  - `submitResult` already stores at most one result per lease (unique lease and hash). It now also takes a row
    lock on the lease, so racing submits run one at a time. There is no migration.
  - After a restart, `planRecovery` resumes every open task workflow and abandons, unpaid, open leases that no
    workflow owns. It waits while a workflow has not yet recorded its lease.
  - A resumed run abandons if the deadline has passed and renews if a fifth or less is left. A finished result
    is always submitted.
- **Measured durability** (`src/main/temporal/durability.test.ts`): a real dev server, a stand-in coordinator, a
  3 s harness, and the worker process killed with SIGKILL.

  | Scenario | Runs | Completed | Stored results | Extra results | Harness runs | Submit replays | Mean ms | Added ms |
  |---|---|---|---|---|---|---|---|---|
  | baseline | 3 | 3 | 3 | 0 | 3 | 0 | 3606 | 0 |
  | kill during run | 3 | 3 | 3 | 0 | 6 | 0 | 14608 | 11002 |
  | kill during submit | 2 | 2 | 2 | 0 | 2 | 2 | 19687 | 16081 |
  | kill worker and server | 2 | 2 | 2 | 0 | 4 | 0 | 17157 | 13551 |

  Completion was 10 of 10 runs, with 0 duplicate results. The added time comes from the 10 s heartbeat timeout
  (a kill during the run) and the 15 s submit step limit (a kill during submit). A graceful quit stops the
  server, and the task resumes on the next launch.
- **E2E check:** the client e2e kills the Electron main process and the Temporal server mid-task with SIGKILL, then
  relaunches. The same lease resumes and gets exactly one stored result, with one extra model call. In the first
  runs, the time from the kill to the result being submitted was 11,326 ms, 12,041 ms and 12,023 ms.
  - One earlier run failed: after the relaunch, the task was not resumed and the history stayed empty. The cause
    was not found. The node now writes `userData/temporal/engine.log` (engine start, open workflows found,
    server errors; no task data), and the test prints it on failure. Three later full runs passed.
- **Budget:** see `packages/node-core/src/budget.ts` and the proxy guard in `packages/sandbox/src/proxy.ts`.
  - Spend is counted in USD micros per local day.
  - The node cap is the smallest of the node's own cap and every joined Henge member cap.
  - The model proxy checks pause, the schedule (task calls only; qualification calls are allowed while the
    user is active) and the cap before every model call. A call refused for the cap gets 402; one refused while
    paused or off schedule gets 423.
  - When the cap is reached, the node pauses with "Paused: daily cap reached", and the running task goes back
    to the queue, unpaid. Resume cannot lift the cap pause; a new day or a higher cap does (checked every
    30 s).
  - Spend comes from the cost the proxy reports. Local models report 0, so the cap only binds API-priced
    calls. The e2e test uses `SWARM_EXPLORER_TEST_CALL_COST_USD_MICROS`, which only unpackaged runs read.
- **Pause reasons:** user, daily_cap and reconsent. The overview shows `pausedLabel`. The renderer shell has one
  changed line, which shows that label instead of a fixed "Paused".
- **Dev route:** `apps/web/app/v1/dev/tasks` uploads and lists example tasks for e2e tests. It is dev only,
  sits behind dev sign-in, and needs `x-dev-tool: 1`.
- **Not done (needs Rex):**
  - Admission for request-mode Henges waits for an `admitted` signal, but nothing sends it yet (it needs a
    community-server admission endpoint).
  - The join, cap and re-consent screens are not wired into the renderer (that is the renderer agent's area);
    the bridge methods exist.
  - A packaged build that carries the binary was configured, not run.
