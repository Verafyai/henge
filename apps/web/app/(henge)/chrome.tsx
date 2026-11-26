import { footer, nav } from '@/lib/henge-landing-copy';

/** The Henge mark (apps/client/src/renderer/assets/henge-mark.svg). `id` keeps each glow filter unique on the page. */
export function HengeMark({ id, className, decorative = true }: { id: string; className?: string; decorative?: boolean }) {
  const filter = `hg-glow-${id}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="380 100 265 642"
      className={className}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : 'Henge'}
    >
      <defs>
        <filter id={filter} x="-50%" y="-20%" width="200%" height="140%">
          <feGaussianBlur stdDeviation="7" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect x="394" y="114" width="236" height="614" rx="118" fill="none" stroke="#C9CCD1" strokeWidth="9" />
      <g fill="#FF2A3D" filter={`url(#${filter})`}>
        <rect x="505" y="140" width="12" height="562" />
        <rect x="486" y="176" width="52" height="11" />
        <rect x="486" y="198" width="52" height="11" />
        <rect x="486" y="220" width="52" height="11" />
        <rect x="486" y="242" width="52" height="11" />
        <polygon points="452,322 566,276 570,287 456,333" />
        <polygon points="452,349 566,303 570,314 456,360" />
        <rect x="511" y="377" width="57" height="11" />
        <rect x="511" y="401" width="57" height="11" />
        <rect x="511" y="425" width="57" height="11" />
        <rect x="511" y="449" width="57" height="11" />
        <rect x="511" y="473" width="57" height="11" />
        <rect x="486" y="529" width="52" height="11" />
        <rect x="486" y="552" width="52" height="11" />
        <rect x="486" y="575" width="52" height="11" />
        <rect x="486" y="598" width="52" height="11" />
        <rect x="455" y="655" width="56" height="12" />
      </g>
    </svg>
  );
}

/** Glyph icon from the mockups (mockups/src/common.py). */
export function GlyphIcon({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" style={{ flex: 'none' }}>
      <rect x="2" y="1.5" width="12" height="13" rx="3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4v8M8 6.2l2.6-1.6M8 9.4l-2.6-1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function HengeNav() {
  return (
    <header>
      <a href="#main" className="hg-skip">
        Skip to content
      </a>
      <nav className="hg-nav hg-wrap" aria-label="Main">
        <a href="/" className="hg-brand" aria-label={nav.homeLabel}>
          <HengeMark id="nav" className="hg-nav-mark" />
          <span className="hg-wordmark">{nav.wordmark}</span>
          <span className="hg-by">{nav.byline}</span>
        </a>
        <div className="hg-links">
          {nav.links.map((l) => (
            <a key={l.label} href={l.href}>
              {l.label}
            </a>
          ))}
          <a href={nav.button.href} className="hg-btn hg-btn-primary hg-btn-nav">
            {nav.button.label}
          </a>
        </div>
      </nav>
    </header>
  );
}

export function HengeFooter() {
  return (
    <footer className="hg-footer">
      <div className="hg-wrap hg-footer-row">
        <span>
          {footer.lead}{' '}
          <a href={footer.verafy.href} className="hg-footer-verafy">
            {footer.verafy.label}
          </a>
        </span>
        <ul className="hg-footer-links" aria-label="Footer">
          {footer.links.map((l) => (
            <li key={l.label}>{l.href ? <a href={l.href}>{l.label}</a> : <span>{l.label}</span>}</li>
          ))}
        </ul>
      </div>
    </footer>
  );
}

export function DownloadArrow() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 2v10M3.5 7.5 8 12l4.5-4.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
