# Built-in Glyph manifests (examples)

These six files are **example manifests** for the built-in Glyphs of publisher `verafy` (spin-out spec v2,
section 7.1). They are test fixtures, not released Glyphs, and no value in them is a measured result.

- `governance.glyph.yaml` is copied unchanged from the spec bundle (`glyphs/governance.glyph.yaml`).
- The other five are written for these tests. `permissions.requests` equals what `example.henge.yaml`
  grants each Glyph, so that file validates against them. Rune ids follow the "Example Runes" column of
  section 7.1. Runtime is `declarative` for all six; `runs_on` is `local_node` only for the Strategy Glyph,
  because it writes into agent context on the member's node.

## Where Rune defaults come from

A default is taken from `example.henge.yaml` (the value that file sets) or from `governance.glyph.yaml`.
When neither gives one, the default is `null`. No default is invented.

| Glyph | Rune | Default | Source |
|---|---|---|---|
| treasury | `unit` | `credits` | example.henge.yaml |
| treasury | `payout.per_accepted_task` | `null` | example.henge.yaml (null until the pool is funded) |
| treasury | `spend.requires_vote_over` | `null` | example.henge.yaml (set by vote) |
| benchmark | `schedule` | `nightly` | example.henge.yaml |
| benchmark | `benchmark_id` | `null` | names one Henge's benchmark (`rf-v1` in the example), so it is not a Glyph default |
| benchmark | `post_to` | `results` | example.henge.yaml; the Glyph creates this channel |
| strategy | `active_strategies` | `null` | names one Henge's strategies, so it is not a Glyph default |
| learnings | `promotion.requires_heldout_gain` | `true` | example.henge.yaml |
| learnings | `promotion.min_runs` | `3` | example.henge.yaml |
| learnings | `context.max_tokens` | `8000` | example.henge.yaml |
| moderation | `auto_timeout.reports` | `3` | example.henge.yaml |
| moderation | `auto_timeout.window_minutes` | `10` | example.henge.yaml |
| moderation | `auto_timeout.duration_minutes` | `60` | example.henge.yaml |
| moderation | `link_filter` | `new_members_only` | example.henge.yaml |

`min` values are logical lower bounds only (a count or a duration is at least 1; a payout is a positive
whole number of credits, as ManifestV1 already requires). No `max` is set where the spec gives none.
Every Rune here keeps the schema default `change_requires: vote`. `schedule` and `link_filter` are typed
`string` because the spec names only one value for each; their full option lists are a question for Rex.
