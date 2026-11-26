import type { Metadata } from 'next';
import { glyphDirectory } from '@/lib/henge-landing-copy';
import { GlyphIcon } from '../chrome';

export const metadata: Metadata = { title: glyphDirectory.title };

/** /glyphs: read-only list of the six built-in Glyphs (spin-out spec 7.1). */
export default function GlyphsPage() {
  return (
    <div className="hg-page">
      <div className="hg-wrap">
        <p className="hg-kicker">{glyphDirectory.kicker}</p>
        <h1 className="hg-h1-page">{glyphDirectory.h1}</h1>
        <p className="hg-p">{glyphDirectory.p}</p>
        <ul className="hg-grid3">
          {glyphDirectory.items.map((g) => (
            <li key={g.name} className="hg-card" data-glyph={g.kind}>
              <div className="hg-glyph-head">
                <span className="hg-glyph-icon">
                  <GlyphIcon />
                </span>
                <div>
                  <h2>{g.name}</h2>
                  <span className="hg-kind">{g.kind}</span>
                </div>
              </div>
              <p>{g.body}</p>
              <p className="hg-runes-label">{glyphDirectory.runesLabel}</p>
              <ul className="hg-runes">
                {g.runes.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <p className="hg-fine">{glyphDirectory.note}</p>
      </div>
    </div>
  );
}
