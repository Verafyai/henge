# Code signing and release key procurement checklist

Carried forward from SwarmStarter (SPEC 18.1) and kept current for Swarm Explorer, because lead times are long.
Requirements come from SPEC 11 and 15. **Nothing here is signed with production certificates without Rex's
separate approval.** All builds so far use test signing only.

Owner for every row: Rex (legal entity and accounts). Status: not started unless noted.

## 1. Apple (macOS)
- [ ] Confirm the legal entity name that will appear as the developer (must match D-U-N-S record).
- [ ] D-U-N-S number for the entity (free from Dun & Bradstreet; can take 1 to 2 weeks).
- [ ] Apple Developer Program, **Organization** enrollment ($99 per year; review can take days to weeks).
- [ ] Create a **Developer ID Application** certificate (signs the app and DMG).
- [ ] Create a **Developer ID Installer** certificate only if we ship a .pkg (not planned).
- [ ] App Store Connect API key (issuer id, key id, .p8) for `notarytool` notarization in CI.
- [ ] Decide entitlements, kept minimal: hardened runtime, `com.apple.security.virtualization` for the
      VM-grade isolation (SPEC 11.2). No JIT or unsigned memory entitlements unless Electron requires them; record why.
- [ ] Store the certificate .p12 and API key in the protected release environment, never on developer laptops.

## 2. Windows
- [ ] Choose OV or EV Authenticode. Since June 2023 private keys must live on a hardware module, so pick a
      **cloud HSM signing service** (for example Azure Trusted Signing, DigiCert KeyLocker or SSL.com eSigner).
      No private keys on CI disks.
- [ ] Organization validation with the chosen CA (business documents, phone verification; 1 to 3 weeks).
- [ ] Service credentials scoped to signing only, stored in the protected release environment.
- [ ] Plan SmartScreen reputation: sign every build from day one with the same identity; monitor warnings.

## 3. Linux
- [ ] Generate a **minisign** key pair offline for AppImage detached signatures.
- [ ] Publish the public key on the download page and in the repo.

## 4. Update manifest release key (SPEC 15.1)
- [ ] Generate an **ed25519** release key **offline** (air-gapped machine or hardware key).
- [ ] Embed the public key in the client at build time; keep the private key offline. Signing a manifest is a
      manual, reviewed step.
- [x] Generate a separate **test** ed25519 key for the internal channel and CI. Never reuse it for Stable or Beta.
      (Generated per machine by `release:test` into gitignored `.data/release-test`.)
- [ ] Write down a rotation and compromise procedure (new key shipped in a release signed by the old key).

## 5. Release infrastructure
- [ ] GitHub environment `release` with required reviewers; signing jobs run only there.
- [ ] Release CDN bucket with immutable versioned paths, HTTPS only, host pinned in the client. No release host is
      approved yet; the client pins only the reserved `releases.swarm-explorer.test` name used by test releases.
- [ ] SBOM (CycloneDX) and reproducibility notes generated per release.

## 6. Deep link and protocol registration
- [x] Register the `henge://` scheme via electron-builder (`protocols` in electron-builder.yml; local builds only).
- [ ] HTTPS `/open/...` fallback on the website (SPEC 4.4). Not built yet.
- [ ] Legacy `swarmstarter://`: not registered. SPEC 4.4 allows it only as a redirect after an approved migration mapping.

## 7. Publisher signing keys (SPEC 6.4, 11.6)
- [ ] Verafy's production publisher key for the launch swarms: generate on hardware-backed or OS secure storage,
      never commit it. Seeds generate a throwaway `verafy-local-test-*` key per run and discard the private half.
- [ ] Platform key for the signed revocation feed and kill switch (SPEC 11.6), kept offline like the release key.
      Built in M7: entries are Ed25519 signed over `swarm-explorer-revocation-v1\n` plus canonical JSON, and
      clients pin keys at build time (`MAIN_VITE_REVOCATION_PUBKEYS`). Until a production key exists, the server
      uses `PLATFORM_REVOCATION_KEY` if set, else a throwaway per process dev key, and test builds trust the keys
      the feed lists.
- [ ] Platform key for contribution receipts (M7), separate from the revocation key. Same rules: `PLATFORM_RECEIPT_KEY`
      if set, else a throwaway dev key; public keys are listed at `GET /v1/receipts/keys`.
