/**
 * Strings for the /s link preview. No em or en dashes (henge-preview.test.ts checks). Size caps are
 * computed from the resolver's constants, never typed here.
 */

export const EXAMPLE_PATH = '/examples/resolved-forecasts.henge.yaml';

export const preview = {
  submit: 'Preview',
  tryExample: 'Try the example',
  exampleNote: 'An example Henge. Every value in it is illustrative.',
  openInHenge: 'Open in Henge',
  openNote: 'Opens the Henge client, if it is installed, and asks before joining.',
  kicker: 'Henge preview',
  publishedBy: 'Published by',
  aboutHeading: 'About this Henge',
  admissionHeading: 'How to join',
  glyphsHeading: 'Glyphs added',
  noGlyphs: 'No Glyphs added.',
  glyphUnchecked: 'This preview lists the Glyph as written; its manifest was not fetched.',
  grantedLabel: 'Granted',
  runesLabel: 'Runes',
  sourceHeading: 'Source',
  sourceUrl: 'Link',
  fetchedFrom: 'Fetched from',
  digest: 'Pinned digest',
  version: 'Version',
  commit: 'Commit',
  etag: 'ETag',
  linksHeading: 'Links',
  bundleOnly: 'In the bundle',
  singleFileNote: 'This is a single .henge file, so the landing body and images that live in a bundle are not included.',
  sanitizedNote: 'Some markup in the landing page was removed for safety.',
  admission: {
    mode: 'Admission',
    modes: { open: 'Open: anyone can join', request: 'By request: maintainers review each request', invite: 'By invite only', allowlist: 'Allowlist only' },
    identity: 'Identity',
    minClient: 'Minimum client version',
    qualification: 'Qualification',
    qualificationText: (pass: number, tasks: number) => `Pass ${pass} of ${tasks} known-answer tasks before real work`,
    attest: 'You will be asked to accept',
    reviewBy: 'Requests reviewed by',
    capacity: 'Capacity',
    noCap: 'No member cap',
    maxMembers: (n: number) => `Up to ${n} members`,
    leave: 'Leaving',
    leaveAllowed: 'You can leave any time',
    leaveNotAllowed: 'Leaving is not allowed by this file',
  },
  errors: {
    heading: 'This link cannot be previewed',
    bad_url: { title: 'That is not a link', detail: 'Paste a full https link to a .henge file.' },
    not_https: { title: 'Only https links can be previewed', detail: 'This link does not use https. Ask the publisher for an https link.' },
    private_address: { title: 'That address is not public', detail: 'The link points at a private, loopback or reserved network address, so it was not fetched.' },
    url_credentials: { title: 'Links with a password are refused', detail: 'Remove the user name and password from the link.' },
    dns_failed: { title: 'That host could not be found', detail: 'Check the link for typos.' },
    too_large: { title: 'That file is too large', detail: 'The .henge file or bundle is over the size cap.' },
    http_status: { title: 'The link did not return a file', detail: 'The server answered with an error.' },
    redirects: { title: 'The link redirects too many times', detail: 'Use the final address of the file.' },
    unreachable: { title: 'The link could not be reached', detail: 'The server did not answer in time or refused the connection.' },
    invalid: { title: 'This is not a valid .henge file', detail: 'The file was fetched, but it does not pass validation. The first problems:' },
    rate_limited: { title: 'Too many previews from your address', detail: 'Wait a minute and try again.' },
    failed: { title: 'The preview failed', detail: 'Something went wrong while reading the file.' },
  },
} as const;

export type PreviewErrorKind = Exclude<keyof typeof preview.errors, 'heading'>;
