/**
 * The Temporal CLI build the node bundles (spin-out spec v2, 9.3). Fetched at build time only, by
 * `scripts/fetch-temporal.mts`, and checked against these SHA-256 values from the release's
 * checksums.txt and these sizes from the release asset list. License: MIT.
 */
export const TEMPORAL_CLI = {
  version: '1.10.0',
  license: 'MIT',
  archives: {
    'darwin-arm64': { file: 'temporal_cli_1.10.0_darwin_arm64.tar.gz', sha256: '40a76ef7d525e6195b083e4cd50b184cc3bb242fea7f8dda2b9a8698ecbb7379', bytes: 36857799 },
    'darwin-x64': { file: 'temporal_cli_1.10.0_darwin_amd64.tar.gz', sha256: '150603ba135dc5f40f0a8f33b1a09732469692fae9a78e3024318e83f023136a', bytes: 39178977 },
    'linux-x64': { file: 'temporal_cli_1.10.0_linux_amd64.tar.gz', sha256: '521f461f3d108902763bb71e85cd0fd382dc9357b59604ae03da6ae734d16890', bytes: 38337871 },
    'linux-arm64': { file: 'temporal_cli_1.10.0_linux_arm64.tar.gz', sha256: '6e526d2f089bf5acead2129f1f63e303b848410d5d9d86b9255359dcea6eaaa8', bytes: 35070119 },
    'win32-x64': { file: 'temporal_cli_1.10.0_windows_amd64.tar.gz', sha256: '08dc600ed4e6ed3ecd9ffc135ac8834c679a96275a5709acfa4034e1b42ad8db', bytes: 39201134 },
    'win32-arm64': { file: 'temporal_cli_1.10.0_windows_arm64.tar.gz', sha256: 'a37f82cdc77d8eddddd1ce94cf1d200918b2b34fc4bbe9fdda2c37572cacf431', bytes: 35207533 },
  },
} as const;
