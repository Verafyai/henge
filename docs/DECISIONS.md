# Henge decisions

Implementation decisions made while building from `docs/SWARM-EXPLORER-SPEC.md`. Items marked **Needs Rex** are open
business or hosting choices that the spec leaves unapproved; the code keeps them as configuration or placeholders.
SwarmStarter decisions are archived in `docs/history/swarmstarter/DECISIONS.md`.

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
- Model artifact hashes are fixture digests, not real downloads, so the M2 hash check will block them by design.
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
- **E2E prerequisite (unchanged):** the client suite needs a fresh local database each run:
  `pnpm db:reset && pnpm --filter @swarm-explorer/client release:test`, then `pnpm e2e`. A later test publishes
  a permission-changing release, so a second run against the same database fails.
