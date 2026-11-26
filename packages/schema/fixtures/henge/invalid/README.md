# Failing `.henge` fixtures

Each file is one failing case for one rule, applied to `../valid/example.henge.yaml` by `src/henge.test.ts`.
Values are examples. Keys:

- `check`: `validate` (schema and single-file invariants), `bundle` (a bundle made of the example plus
  `files`), `update` (previous version against next version) or `join` (the member's own settings).
- `set` / `unset`: JSON Pointer edits to the example. For `update`, `previous.set` edits the previous
  version and `set` the next one; `previous.files` and `files` are the two bundles' extra files.
- `expect`: the issue code the rule must report. `expect_reconsent` lists fields that must trigger re-consent.
