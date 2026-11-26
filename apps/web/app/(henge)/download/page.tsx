import type { Metadata } from 'next';
import { download } from '@/lib/henge-landing-copy';

export const metadata: Metadata = { title: download.title };

/**
 * /download (spin-out spec 5.2 and B5). No build exists, so every button is disabled and nothing
 * links to GitHub Releases yet. Never show a version or size here until a real release exists.
 */
export default function DownloadPage() {
  return (
    <div className="hg-page">
      <div className="hg-wrap">
        <h1 className="hg-h1-page">{download.h1}</h1>
        <p className="hg-p">{download.p}</p>
        <ul className="hg-platforms">
          {download.platforms.map((p) => (
            <li key={p.name} className="hg-card" data-platform={p.name}>
              <h2>{p.name}</h2>
              <p>{p.note}</p>
              <button type="button" className="hg-btn hg-btn-lg" disabled aria-disabled="true">
                {p.status}
              </button>
            </li>
          ))}
        </ul>
        <p className="hg-fine">{download.footnote}</p>
      </div>
    </div>
  );
}
