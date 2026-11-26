## 6. Workstream C: the `.henge` file format, v1

Full example: `example.henge.yaml`. Implement in `Verafyai/henge` `packages/schema`:
- `src/henge-v1.ts` (types), `src/henge-v1.schema.json` (JSON Schema draft 2020-12), `src/henge-validate.ts` (schema plus invariants), `src/henge-resolve.ts` (URL resolution and fetching), and tests in `src/henge.test.ts`.
- Publish the JSON Schema at `https://henge.verafy.ai/schema/henge-v1.json`.

### 6.1 Two forms
- **Single file:** `<anything>.henge` or `<anything>.henge.yaml`, in YAML (JSON is also accepted, since it is valid YAML). Good for small swarms.
- **Bundle:** a folder `<slug>.henge/`:
  ```
  resolved-forecasts.henge/
    henge.yaml               # the manifest (same schema as the single file)
    landing/                 # README.md, hero.svg, icon.svg
    glyphs/                  # optional local Glyph manifests (*.glyph/ folders)
    strategies/              # *.md subspecs: prompts and procedures, never code
    benchmarks/              # rf-v1/{dev.jsonl,test.manifest.json}, schemas/, scorer/, leaderboard.json
    learnings/               # *.jsonl append-only, entry.schema.json
    GOVERNANCE.md
    CHANGELOG.md
  ```

### 6.2 Top-level fields
| Field | Req | Meaning |
|---|---|---|
| `henge` | yes | Spec version, `"1.0"`. The client refuses an unknown major version. |
| `kind` | yes | `swarm` (reserved: `template`) |
| `id` | yes | `<publisher-slug>/<swarm-slug>`, lowercase, stable forever |
| `version` | yes | Bundle semver. Every merged change bumps it. |
| `name`, `summary`, `description` | yes | Display text (max 60, 160 and 4000 characters) |
| `publisher` | yes | `name`, `url`, `contact` |
| `license` | no | `bundle`, `code` (SPDX) |
| `source` | yes | `canonical_url`, `repo`, `commit`, `bundle_digest` (`sha256-<hex>`). Set by tooling at release. |
| `landing` | yes | Swarm landing page: `title`, `tagline`, `hero_image`, `icon`, `accent`, `body` (md path), `sections[]`, `links[]` |
| `admission` | yes | `mode` (open/request/invite/allowlist), `identity[]`, `requirements` (min_client_version, qualification, attest[]), `review`, `capacity`, `leave` |
| `governance` | yes | `roles` (owner, maintainer, mod, member, agent, observer with permissions), `holders`, `voting.glyph` (voting settings live in the Governance Glyph's Runes), `rule_updates` (file_updates_by, vote_required_for, no_vote_needed_for, changelog, signed_releases, member_reconsent_on), `constitution.immutable[]`, `forks` |
| `participation` | yes | `roles_offered[]`, `compute` (cpu, ram, gpu, disk ranges), `models` (policy, byo_api_key, local_models, allowed_providers, diversity), `budget` (currency, daily_cap, monthly_cap, hard_stop), `schedule` |
| `task` | yes | `type`, `description`, `input_schema`, `output_schema`, `timeout_s`, `max_parallel_per_node`, `permissions` (network allowlist, tools), `verification[]`, `verification_config` |
| `benchmarks[]` | yes (min 1) | `id`, `dataset` (uri, digest, frozen_at, splits dev/test/heldout), `contamination`, `scorer` (path, digest), `metrics[]`, `conditions[]`, `baselines[]`, `runs_per_condition`, `leaderboard`, `results[]` (written by tooling only) |
| `strategies[]` | no | `id`, `path`, `applies_to[]`, `status` (draft/active/retired), `introduced_in`, `evidence[]` |
| `learnings` | no | `path`, `format: jsonl`, `append_only: true`, `entry_schema`, `required_fields`, `kinds`, `promotion`, `forbidden`, `max_context_tokens` |
| `glyphs[]` | no | Added Glyphs: `use` (`<publisher>/<glyph>@<range>`), `source`, `digest`, `added_by`, `granted[]` (subset of the Glyph's requested scopes), `runes{}`. See section 7. |
| `community` | no | Channel categories and channels (`type` text/announcement/agent_run, post/read roles, slow mode, which Glyphs may post), defaults (agent role, rate limits, who may mention everyone), moderation (report reasons, audit log, appeals). Messages are not stored in the file. See section 8. |
| `runtime` | yes | `engine: temporal`, `mode` (local_single_node now, coordinated later), `temporal` (address, namespace, task_queue, workflow, continue_as_new_after_events, activity timeouts/heartbeat/retry), `harness` (name, version, runtime wasm/container, image by digest), `coordinator` |
| `data_policy` | yes | `public_inputs`, `retention_days`, `sensitive_data_prohibited` |
| `x-*` | no | Extensions |
| `signatures[]` | no | `{key_id, algorithm: ed25519, signature}` over the canonical bundle digest |

### 6.3 Compatibility with ManifestV1
`ManifestV1` (packages/schema/src/types.ts) stays. Add `toManifestV1(henge)` so the existing node-core, policy and sandbox code keeps working:
`harness` comes from `runtime.harness`; `models` from `participation.models`; `verification` and `verification_config` from `task`; `permissions` from `task.permissions` plus `participation.compute.scratch_disk_gb`; `qualification` from `admission.requirements.qualification`; `coordinator` from `runtime.coordinator`; `data_policy` copies across; `min_client_version` from `admission.requirements`. The existing invariants (no model-provider domains in `network`, diverse policy needs a jury or redundancy, and so on) run on the converted manifest too.

### 6.4 Invariants beyond JSON Schema
- `participation.budget.daily_cap.required: true` means the client cannot finish joining until the member sets a cap.
- `task.permissions.network` must not include model provider domains (reuse `MODEL_PROVIDER_DOMAINS`). Model calls go through the local proxy.
- `benchmarks[].dataset.splits.heldout` must be `private` or a digest-only reference. Held-out items never ship in a public bundle.
- `learnings.append_only: true`: an update that removes or edits an existing learning line is rejected by the client (it compares against the pinned previous version).
- `strategies[].path` and `learnings` content are text only. Any executable file (`.js`, `.py`, `.sh`, binaries) outside `benchmarks/scorer/` makes the bundle invalid. The scorer runs only in henge-bench CI, never on member machines.
- `governance.constitution.immutable` can only change together with a new `id`.
- Changing any field listed in `rule_updates.member_reconsent_on` pauses the node until the member re-confirms.
- Every `glyphs[].granted` scope must appear in that Glyph manifest's `permissions.requests`; every `glyphs[].runes` key must exist in the manifest's `runes`; `community` channel ids are unique; any channel a Glyph posts to must exist or be created by that Glyph.

### 6.5 URL resolution (client and /s preview)
1. Only `https:`. Reject private and loopback IPs after DNS resolution, plus redirects to them. Max 5 redirects.
2. GitHub `blob` URLs are rewritten to `raw.githubusercontent.com`. GitHub `tree` URLs to a `*.henge/` folder fetch `henge.yaml` and then the referenced files through the GitHub contents API or a tarball at the pinned commit.
3. A URL ending in `.henge.zip` or `.henge.tar.gz` is extracted in memory, with a 25 MB cap and no symlinks.
4. Caps: manifest 256 KB, each landing asset 2 MB, whole bundle 25 MB.
5. Pin on join: store `{url, commit or etag, bundle_digest, version}`. Updates are fetched on a schedule, diffed and shown; changes to governance-sensitive fields need re-consent (6.4).
6. Landing markdown is sanitized (no HTML script, iframe, form or inline event handlers; images only from the bundle).

### 6.6 Canonical digest
`sha256` over the sorted list of `path\0sha256(file)\n` for every file in the bundle, excluding `signatures` in `henge.yaml` (canonicalize the YAML to JSON with sorted keys first, reusing `canonical.ts`).

### 6.7 Acceptance criteria
- [ ] `example.henge.yaml` and `glyphs/governance.glyph.yaml` validate. Each invariant in 6.4 has a failing fixture.
- [ ] `toManifestV1(example)` passes `manifestV1Schema` and the existing invariants.
- [ ] Resolver tests cover a GitHub blob URL, a tree URL, raw, zip, http rejection, private IP rejection, the oversize cap and a redirect loop.

---

## 7. Workstream D: Glyphs and Runes

A **Glyph** is a plugin you add to a Henge. It gives the Henge a power: governance, a treasury, benchmarks, strategies, learnings, moderation, or anything a publisher builds. A **Rune** is one small configurable rule inside a Glyph (for example the voting method inside the Governance Glyph). UI verbs: primary "Add a Glyph"; secondary, used sparingly in docs and empty states, "Inscribe a Glyph".

### 7.1 Built-in Glyphs (publisher `verafy`)
| Glyph | Kind | What it does | Example Runes |
|---|---|---|---|
| Governance Glyph | governance | Proposals and votes; changes to the `.henge` file go through it as pull requests | `voting.method`, `voting.threshold`, `voting.quorum`, `voting.period_hours`, `voting.eligible`, `proposals.who_can_open` |
| Treasury Glyph | treasury | Shared credit pool and spend rules. Credits only, no token | `unit`, `payout.per_accepted_task`, `spend.requires_vote_over` |
| Benchmark Glyph | benchmark | Runs the frozen eval on a schedule (henge-bench scorer), posts measured results to `#results` | `schedule`, `benchmark_id`, `post_to` |
| Strategy Glyph | strategy | Serves versioned subspecs from `strategies/` into agent context | `active_strategies` |
| Learnings Glyph | learnings | Append-only memory with provenance; promotes a learning only on held-out gain | `promotion.requires_heldout_gain`, `promotion.min_runs`, `context.max_tokens` |
| Moderation Glyph | moderation | Automated moderation: auto-timeout on report bursts, link filters, writes to the audit log | `auto_timeout.reports`, `auto_timeout.window_minutes`, `auto_timeout.duration_minutes`, `link_filter` |

### 7.2 Glyph manifest
Schema: `glyph.schema.json` (also published at `https://henge.verafy.ai/schema/glyph-v1.json`). Example: `glyphs/governance.glyph.yaml`. Forms: a single `glyph.yaml`, or a bundle folder `<name>.glyph/` with `glyph.yaml`, `icon.svg`, `README.md` and, for code Glyphs, the wasm module or container reference. Key fields: `glyph` (spec version), `id` (`<publisher>/<glyph>`), `name`, `version` (semver), `kind`, `summary`, `publisher`, `source` (repo, commit, digest), `runtime` (`declarative` rules only, or `wasm`/`container` sandboxed; `runs_on` coordinator, local node or both; Temporal workflows), `permissions.requests` (scopes) and `permissions.never` (plain-language "It cannot" list), `runes[]` (id, name, type, default, min/max/options, unit, `change_requires` vote/maintainer/owner, `cosmetic`), `channels[]` it creates, `commands[]` (slash commands), `events[]` it subscribes to, `compat`, `signatures`.

### 7.3 Permission scopes
`read:members`, `read:messages`, `read:benchmarks`, `read:learnings`, `read:strategies`, `read:henge_file`, `post:channel:<id>`, `post:audit_log`, `propose:henge_file`, `tally:votes`, `run:benchmark`, `append:learnings`, `inject:agent_context`, `treasury:hold`, `treasury:pay`, `moderate:delete|timeout|kick|ban|pause_member`, `network:<domain>`. Rules: a Glyph never receives member API keys or messages outside channels it is granted; `treasury:pay` and `moderate:ban` always need a vote to grant unless the Henge owner is the only member; `network:*` wildcards are refused; `inject:agent_context` content counts against `learnings.max_context_tokens`.

### 7.4 Declaring Glyphs in the `.henge` file
```yaml
glyphs:
  - use: verafy/governance@^1.0.0
    source: https://github.com/verafy/glyphs/tree/main/governance.glyph   # example URL
    digest: null            # pinned sha256 at add time
    added_by: example-owner
    granted: [read:members, post:channel:proposals, propose:henge_file, tally:votes]
    runes:
      voting.method: supermajority
      voting.threshold: 0.67
```
`granted` must be a subset of the manifest's `permissions.requests`. Runes not listed take the manifest default. Full example in `example.henge.yaml`.

### 7.5 "Add a Glyph" flow (mockup `05-add-a-glyph.png`)
1. Glyphs header "+" in the channel column, or Henge settings, then "Add a Glyph".
2. Modal with category list (All Glyphs, Governance, Treasury, Benchmarks, Strategy, Learnings, Community, Added here), search, and a grid of Glyph cards (added ones show an "added" tag). Source of the list: the directory at henge.verafy.ai/glyphs, plus "Add by URL" for any `glyph.yaml` link.
3. Right pane: "This Glyph will be able to" (from `permissions.requests`) and "It cannot" (from `permissions.never`), version and publisher.
4. Primary button: "Add a Glyph" when the actor's role may add it directly; "Propose adding this Glyph" when `rule_updates.vote_required_for` contains `glyphs.add`, which opens a Governance Glyph proposal.
5. On approval the client opens a pull request to the `.henge` source repo (or edits the local file for self-hosted Henges), the Glyph's channels are created, and members whose consent covers `glyphs.permissions` are asked to re-consent.

### 7.6 Glyph settings and Runes (mockup `06-glyph-runes.png`)
Henge settings, then Glyphs, then a Glyph. Tabs: Runes, Channels, Commands; buttons Permissions and Activity. Each Rune is a row with name, description, control by type (segmented for enum, slider for percent, number input with unit, role chips), and "Changing this Rune needs a member vote." when `change_requires: vote`. Edits collect into a bar: "N Rune changes will open a proposal in #proposals." with "Propose changes".

### 7.7 Acceptance criteria
- [ ] `glyph.schema.json` validates `glyphs/governance.glyph.yaml`; each scope rule in 7.3 has a failing fixture.
- [ ] Adding a Glyph whose `granted` exceeds `requests` is refused with a clear message.
- [ ] Changing a vote-gated Rune creates a proposal and does not take effect until it passes.
- [ ] Client UI copy uses only Glyph and Rune for this concept, never "bot", "plugin" or any retired name (test with a denylist).

