# Code signing and release key procurement checklist

Carried forward from SwarmStarter (SPEC 18.1) and kept current for Swarm Explorer, because lead times are long.
Requirements come from SPEC 11 and 15. **Nothing here is signed with production certificates without Rex's
separate approval.** All builds so far use test signing only.

Owner for every row: Rex (legal entity and accounts). Status: not started unless noted.

## 1. Apple (macOS): Rex's checklist for the Mac alpha

Apple Developer ID signing and notarization are approved (DECISIONS 2026-11-25). The alpha is Mac only, so this is
the only certificate work that blocks M7. Steps 1 to 6 need Rex, as the person who can bind the company; the rest
are done together once the account exists.

1. [ ] **Pick the legal entity** that appears as the developer on every Henge download (for example "Verafy, Inc.":
       use the exact registered name). It must match the D-U-N-S record exactly.
2. [ ] **Get or look up the D-U-N-S number** for that entity at Apple's D-U-N-S lookup on developer.apple.com. Free;
       a new number can take 1 to 2 weeks.
3. [ ] **Use a company Apple Account** (not a personal one) with two-factor authentication on. Whoever enrolls
       becomes the Account Holder, the only role that can create Developer ID certificates.
4. [ ] **Enroll in the Apple Developer Program as an Organization** at developer.apple.com/programs/enroll
       ($99 per year). Have ready: the D-U-N-S number, the legal entity name, a public company website on the entity's
       domain (verafy.ai), and a work email on that domain. Apple may phone to confirm you can bind the company.
       Review takes days to weeks.
5. [ ] **Create the Developer ID Application certificate.** In Keychain Access on the Mac that will hold it:
       Certificate Assistant, then Request a Certificate From a Certificate Authority, saved to disk. Then in
       Certificates, Identifiers & Profiles, add a certificate, choose **Developer ID Application**, upload the request,
       download the certificate and double-click it. Export it with its private key as a password-protected `.p12`.
6. [ ] **Create the notarization API key.** In App Store Connect, Users and Access, Integrations, Team Keys: create a key
       with the **Developer** role. Note the **Issuer ID** and **Key ID** and download the `.p8` (it downloads once).
7. [ ] **Store the secrets** (`.p12`, its password, the `.p8`, Issuer ID, Key ID, Team ID) in the GitHub `release`
       environment with required reviewers (section 5). Delete the local copies. Never on developer laptops, never
       in the repo, never in chat.
8. [ ] **First signed build together:** `electron-builder` signs with hardened runtime and notarizes with
       `notarytool`; we check it with `spctl --assess --type execute` and `stapler validate` before anything is
       published. Publishing the first build still needs Rex's yes.

Not needed for the alpha: a **Developer ID Installer** certificate (only for a .pkg; we ship a DMG and a zip).

Entitlements stay minimal: hardened runtime only. The old `com.apple.security.virtualization` line is gone, because
nodes run no VMs or containers (DECISIONS 2026-11-25). Any JIT or unsigned-memory entitlement Electron needs gets
recorded here with the reason.

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
- [ ] Releases on GitHub Releases under Verafyai (DECISIONS 2026-11-25), immutable versioned assets, HTTPS only, host
      pinned in the client. Until the first signed build, the client pins only the reserved test release name.
- [ ] SBOM (CycloneDX) and reproducibility notes generated per release.

## 6. Deep link and protocol registration
- [x] Register the `swarmexplorer://` scheme via electron-builder (`protocols` in electron-builder.yml; local builds only).
- [ ] HTTPS `/open/...` fallback on the website (SPEC 4.4). Not built yet.
- [ ] Legacy `swarmstarter://`: not registered. SPEC 4.4 allows it only as a redirect after an approved migration mapping.

## 7. Publisher signing keys (SPEC 6.4, 11.6)
- [ ] Verafy's production publisher key for the launch swarms: generate on hardware-backed or OS secure storage,
      never commit it. Seeds generate a throwaway `verafy-local-test-*` key per run and discard the private half.
- [ ] Platform key for the signed revocation feed (SPEC 11.6), kept offline like the release key.
