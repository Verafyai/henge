import { notFound as copy } from '@/lib/henge-landing-copy';
import { HengeFooter, HengeNav } from './(henge)/chrome';
import { chakra } from './(henge)/fonts';
import './(henge)/henge.css';

/** Unmatched URLs on henge.verafy.ai. Henge web pages that call notFound() use app/(web)/not-found.tsx. */
export default function NotFound() {
  return (
    <div className={`hg ${chakra.variable}`}>
      <HengeNav />
      <main id="main" className="hg-wrap hg-404">
        <h1 className="hg-h1-page">{copy.h1}</h1>
        <p className="hg-p" style={{ margin: '14px auto 0' }}>
          {copy.p}
        </p>
        <div style={{ marginTop: 28 }}>
          <a href={copy.back.href} className="hg-btn hg-btn-ghost">
            {copy.back.label}
          </a>
        </div>
      </main>
      <HengeFooter />
    </div>
  );
}
