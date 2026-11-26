# Failing Glyph fixtures (spin-out spec v2, 7.3)

Each file is one failing case for one scope or Rune rule, run by `src/henge.test.ts`. Values are examples.

- `check: manifest` edits `../verafy/<base>.glyph.yaml` with `set` and validates it.
- `check: grant` runs `checkGlyphGrant` for `base` with `grant`.
- `check: henge` edits `../../henge/valid/example.henge.yaml` with `set` and validates it against the built-in manifests.
- `check: runes` runs `planRuneChanges` for `base` with `changes`; `expect_proposal` and `expect_direct` list Rune ids.
