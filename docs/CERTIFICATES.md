# Code signing and release key procurement checklist

Carried forward from SwarmStarter (SPEC 18.1) and kept current for Henge, because lead times are long.
Requirements come from SPEC 11 and 15. **Nothing here is signed with production certificates without Rex's
separate approval.** All builds so far use test signing only.

Owner for every row: Rex (legal entity and accounts). Status: not started unless noted.

## 1. Apple (macOS): Rex's checklist for the Mac alpha (individual enrollment)

Apple Developer ID signing and notarization are approved (DECISIONS 2026-11-25). Rex enrolls **as an individual**
now: no D-U-N-S number, so it skips the longest wait. We move to an organization account later (end of this section).
Steps 1 to 5 need Rex; the rest we do together.

1. [ ] **Use your own Apple Account** with two-factor authentication on, in your legal name. As an individual you are
       the Account Holder, the only role that can create Developer ID certificates.
2. [ ] **Enroll in the Apple Developer Program as an Individual** at developer.apple.com/programs/enroll ($99 per year).
       Apple verifies your identity (often through the Apple Developer app with a government ID). Approval is usually
       quick, but Apple sets the pace.
3. [ ] **Know what users will see:** downloads show your legal name as the developer, not "Verafy", until we move to an
       organization account.
4. [ ] **Create the Developer ID Application certificate.** In Keychain Access on the Mac that will hold it:
       Certificate Assistant, then Request a Certificate From a Certificate Authority, saved to disk. Then in
       Certificates, Identifiers & Profiles, add a certificate, choose **Developer ID Application**, upload the request,
       download the certificate and double-click it. Export it with its private key as a password-protected `.p12`.
5. [ ] **Set up notarization.** Preferred: in App Store Connect, Users and Access, Integrations, create an API key and
       note the **Issuer ID** and **Key ID**, and download the `.p8` (it downloads once). If your account does not offer
       API keys, create an **app-specific password** at account.apple.com for `notarytool` instead, and note your
       **Team ID** (Membership details on developer.apple.com).
6. [ ] **Store the secrets** (`.p12` and its password, the `.p8` or app-specific password, Issuer ID, Key ID, Team ID)
       in the GitHub `release` environment with required reviewers (section 5). Delete local copies. Never on developer
       laptops, never in the repo, never in chat.
7. [ ] **First signed build together:** `electron-builder` signs with hardened runtime and notarizes with `notarytool`;
       we check it with `spctl --assess --type execute` and `stapler validate` before anything is published. Publishing
       the first build still needs Rex's yes.

Not needed for the alpha: a **Developer ID Installer** certificate (only for a .pkg; we ship a DMG and a zip).

Entitlements stay minimal: hardened runtime only. The old `com.apple.security.virtualization` line is gone, because
nodes run no VMs or containers (DECISIONS 2026-11-25). Any JIT or unsigned-memory entitlement Electron needs gets
recorded here with the reason.

**Moving to an organization later** (needs the company's D-U-N-S number and an Organization enrollment). The developer
name and **Team ID** change, which changes the app's signing identity:
- The appId `ai.verafy.henge` and the `henge://` scheme stay the same.
- Updates keep working, because the client trusts our ed25519 update-manifest key (section 4), not the Team ID. Ship
  one update signed by the new identity.
- macOS may ask each user once to let the re-signed app read its existing keychain items.
- Re-run the e2e keychain tests on the newly signed build before publishing it.

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
- [x] Register the `henge://` scheme via electron-builder (`protocols` in electron-builder.yml; local builds only).
- [ ] HTTPS `/open/...` fallback on the website (SPEC 4.4). Not built yet.
- [ ] Legacy `swarmstarter://`: not registered. SPEC 4.4 allows it only as a redirect after an approved migration mapping.

## 7. Publisher signing keys (SPEC 6.4, 11.6)
- [ ] Verafy's production publisher key for the launch swarms: generate on hardware-backed or OS secure storage,
      never commit it. Seeds generate a throwaway `verafy-local-test-*` key per run and discard the private half.
- [ ] Platform key for the signed revocation feed (SPEC 11.6), kept offline like the release key.
