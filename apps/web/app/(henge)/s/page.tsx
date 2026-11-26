import type { Metadata } from 'next';
import { pasteLink } from '@/lib/henge-landing-copy';

export const metadata: Metadata = { title: pasteLink.title };

/** /s: the .henge link preview. Disabled until the resolver lands in its own PR (spin-out spec 6.5). */
export default function PasteLinkPage() {
  return (
    <div className="hg-page">
      <div className="hg-wrap">
        <p className="hg-kicker">{pasteLink.kicker}</p>
        <h1 className="hg-h1-page">{pasteLink.h1}</h1>
        <p className="hg-p">{pasteLink.p}</p>
        <form className="hg-field" aria-describedby="s-note">
          <label htmlFor="henge-url">{pasteLink.label}</label>
          <div className="hg-field-row">
            <input id="henge-url" name="url" type="url" className="hg-input" placeholder={pasteLink.placeholder} disabled />
            <button type="submit" className="hg-btn hg-btn-lg" disabled aria-disabled="true">
              {pasteLink.status}
            </button>
          </div>
          <p id="s-note" className="hg-fine">
            <span className="hg-badge">{pasteLink.status}</span> {pasteLink.note}
          </p>
        </form>
      </div>
    </div>
  );
}
