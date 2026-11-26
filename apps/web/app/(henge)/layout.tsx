import { HengeFooter, HengeNav } from './chrome';
import { chakra } from './fonts';
import './henge.css';

/** henge.verafy.ai: landing, /download, /spec, /glyphs and /s. Dark only. */
export default function HengeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`hg ${chakra.variable}`}>
      <HengeNav />
      <main id="main">{children}</main>
      <HengeFooter />
    </div>
  );
}
