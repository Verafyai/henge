import type { Metadata } from 'next';
import { community, finalCta, previewLabel, glyphs, hengeFile, hero, howItWorks, meta, science } from '@/lib/henge-landing-copy';
import { DownloadArrow, GlyphIcon, HengeMark } from './chrome';

export const metadata: Metadata = { title: { absolute: meta.title }, description: meta.description };

/**
 * henge.verafy.ai landing page (Henge spin-out spec v2, section 5.2, sections 0 to 8). All copy
 * comes from lib/henge-landing-copy.ts. The two images are mockups, captioned as design previews,
 * until the Henge client is built (docs/DECISIONS.md, henge.verafy.ai landing).
 */
export default function Landing() {
  return (
    <>
      {/* 1. Hero */}
      <div className="hg-hero">
        <div className="hg-wrap hg-hero-inner">
          <HengeMark id="hero" className="hg-hero-mark" />
          <h1 className="hg-h1">
            {hero.h1Lead}
            <span className="hg-accent">{hero.h1Accent}</span>
          </h1>
          <p className="hg-sub">
            {hero.subBefore}
            <code>{hero.subCode}</code>
            {hero.subAfter}
          </p>
          <div className="hg-btn-row">
            <a href={hero.primary.href} className="hg-btn hg-btn-primary hg-btn-lg">
              <DownloadArrow />
              {hero.primary.label}
            </a>
            <a href={hero.secondary.href} className="hg-btn hg-btn-ghost hg-btn-lg">
              {hero.secondary.label}
            </a>
          </div>
          <p className="hg-note">{hero.note}</p>
          <Preview src="/henge/design-preview-client.png" alt={hero.previewAlt} caption={hero.previewCaption} className="hg-hide-sm" eager />
        </div>
      </div>

      {/* 2. How it works */}
      <section id={howItWorks.id} aria-labelledby="how-h" className="hg-section hg-section-first">
        <div className="hg-wrap">
          <p className="hg-kicker">{howItWorks.kicker}</p>
          <h2 id="how-h" className="hg-h2">
            {howItWorks.h2}
          </h2>
          <ol className="hg-grid4">
            {howItWorks.steps.map((s) => (
              <li key={s.num} className="hg-card">
                <span className="hg-num">{s.num}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 3. Glyphs */}
      <section id={glyphs.id} aria-labelledby="glyphs-h" className="hg-section">
        <div className="hg-wrap">
          <p className="hg-kicker">{glyphs.kicker}</p>
          <h2 id="glyphs-h" className="hg-h2">
            {glyphs.h2}
          </h2>
          <p className="hg-p">{glyphs.p}</p>
          <ul className="hg-grid3">
            {glyphs.cards.map((c) => (
              <li key={c.title} className="hg-card">
                <span className="hg-glyph-icon">
                  <GlyphIcon />
                </span>
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </li>
            ))}
            <li className="hg-card hg-card-dashed">
              <h3 className="hg-flush">{glyphs.buildYourOwn.title}</h3>
              <p>{glyphs.buildYourOwn.body}</p>
            </li>
          </ul>
        </div>
      </section>

      {/* 4. Community */}
      <section id={community.id} aria-labelledby="community-h" className="hg-section">
        <div className="hg-wrap hg-split hg-split-community">
          <div>
            <p className="hg-kicker">{community.kicker}</p>
            <h2 id="community-h" className="hg-h2">
              {community.h2}
            </h2>
            <p className="hg-p">{community.p}</p>
          </div>
          <Preview src="/henge/design-preview-community.png" alt={community.previewAlt} caption={community.previewCaption} className="hg-hide-sm" />
        </div>
      </section>

      {/* 5. The .henge file */}
      <section id={hengeFile.id} aria-labelledby="file-h" className="hg-section">
        <div className="hg-wrap hg-split hg-split-file">
          <div>
            <p className="hg-kicker">{hengeFile.kicker}</p>
            <h2 id="file-h" className="hg-h2">
              {hengeFile.h2}
            </h2>
            <p className="hg-p">{hengeFile.p}</p>
            <div style={{ marginTop: 24 }}>
              <a href={hengeFile.button.href} className="hg-btn hg-btn-ghost">
                {hengeFile.button.label}
              </a>
            </div>
          </div>
          <pre className="hg-code" aria-label={hengeFile.codeHeader} tabIndex={0}>
            <span className="c">{hengeFile.codeHeader}</span>
            {'\n'}
            {hengeFile.code.map(([indent, key, value], i) => (
              <span key={i}>
                {indent}
                <span className="k">{key}</span>:{value ? ' ' : ''}
                {value.startsWith('"') ? <span className="s">{value}</span> : value}
                {i < hengeFile.code.length - 1 ? '\n' : ''}
              </span>
            ))}
          </pre>
        </div>
      </section>

      {/* 6. Science */}
      <section id={science.id} aria-labelledby="science-h" className="hg-section">
        <div className="hg-wrap">
          <p className="hg-kicker">{science.kicker}</p>
          <h2 id="science-h" className="hg-h2">
            {science.h2}
          </h2>
          <p className="hg-p">{science.p}</p>
          <ul className="hg-grid3">
            {science.cards.map((c) => (
              <li key={c.title} className="hg-card">
                <h3 className="hg-flush">{c.title}</h3>
                <p>{c.body}</p>
              </li>
            ))}
          </ul>
          <div className="hg-card hg-status">
            <span>{science.status}</span>
            {science.button.href ? (
              <a href={science.button.href} className="hg-btn hg-btn-ghost">
                {science.button.label}
              </a>
            ) : (
              <span className="hg-btn hg-btn-ghost" aria-disabled="true" title={science.button.pendingNote}>
                {science.button.label} ({science.button.pendingNote})
              </span>
            )}
          </div>
        </div>
      </section>

      {/* 7. Final CTA */}
      <section aria-labelledby="final-h" className="hg-section hg-final">
        <div className="hg-wrap">
          <HengeMark id="final" className="hg-final-mark" />
          <h2 id="final-h" className="hg-h2">
            {finalCta.h2}
          </h2>
          <div className="hg-btn-row">
            <a href={finalCta.primary.href} className="hg-btn hg-btn-primary hg-btn-lg">
              <DownloadArrow />
              {finalCta.primary.label}
            </a>
            <a href={finalCta.secondary.href} className="hg-btn hg-btn-ghost hg-btn-lg">
              {finalCta.secondary.label}
            </a>
          </div>
          <p>{finalCta.line}</p>
        </div>
      </section>
    </>
  );
}

function Preview({ src, alt, caption, className, eager = false }: { src: string; alt: string; caption: string; className?: string; eager?: boolean }) {
  return (
    <figure className={`hg-shot ${className ?? ''}`} data-design-preview>
      <div className="hg-shot-frame">
        {/* A mockup, never presented as the shipping product: the caption says so. */}
        <img src={src} alt={alt} width={1440} height={900} loading={eager ? 'eager' : 'lazy'} />
      </div>
      <figcaption>
        <span className="hg-shot-label">{previewLabel}</span>
        {caption}
      </figcaption>
    </figure>
  );
}
