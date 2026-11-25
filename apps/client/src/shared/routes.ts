/**
 * In-app routes. Deep links (SPEC 4.4) map onto these and only ever navigate;
 * no link joins, spends, installs or submits anything by itself.
 */
export type Route =
  | { name: 'store'; category?: string }
  | { name: 'swarm'; slug: string }
  /** Opened from henge://join/{swarm}: shows the join review, never joins. */
  | { name: 'join'; slug: string }
  /** A new release changed this membership's permissions; review them again (SPEC 11.4). */
  | { name: 'reconsent'; membershipId: string }
  | { name: 'model'; slug: string }
  /** The model catalog with fit, downloads and storage (SPEC 5.4). */
  | { name: 'models' }
  | { name: 'harness'; slug: string }
  | { name: 'result'; id: string }
  | { name: 'publisher' }
  | { name: 'library' }
  | { name: 'activity' }
  | { name: 'community' }
  | { name: 'wallet' }
  | { name: 'settings' }
  /** Pick a cause (SPEC 3.1). Shown on first run and from Settings > Node. */
  | { name: 'setup' };
