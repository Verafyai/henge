import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { CSSProperties } from 'react';
import { pasteLink } from '@/lib/henge-landing-copy';
import { capsText, clientIp, previewHenge, type PreviewResult, type PreviewView } from '@/lib/henge-preview';
import { EXAMPLE_PATH, preview } from '@/lib/henge-preview-copy';
import { parsePreviewInline } from '@/lib/henge-preview-markdown';
import type { Block } from '@/lib/mini-markdown';

export const metadata: Metadata = { title: pasteLink.title, robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * /s?url=<https url>: the public landing page of any Henge, rendered from its .henge `landing`
 * block (spin-out spec v2, 5.2). The link is fetched on the server only (lib/henge-preview.ts).
 */
export default async function PasteLinkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = typeof sp.url === 'string' ? sp.url : '';
  const h = await headers();
  const host = h.get('host') ?? 'henge.verafy.ai';
  const proto = h.get('x-forwarded-proto') ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  const exampleUrl = `${proto}://${host}${EXAMPLE_PATH}`;
  const result = raw ? await previewHenge(raw, { ip: clientIp(h) }) : null;

  return (
    <div className="hg-page">
      <div className="hg-wrap">
        <p className="hg-kicker">{pasteLink.kicker}</p>
        <h1 className="hg-h1-page">{pasteLink.h1}</h1>
        <p className="hg-p">{pasteLink.p}</p>
        <form className="hg-field" action="/s" method="get" role="search">
          <label htmlFor="henge-url">{pasteLink.label}</label>
          <div className="hg-field-row">
            <input id="henge-url" name="url" type="url" required className="hg-input" placeholder={pasteLink.placeholder} defaultValue={raw} autoComplete="off" spellCheck={false} />
            <button type="submit" className="hg-btn hg-btn-primary hg-pv-submit">
              {preview.submit}
            </button>
          </div>
          <p className="hg-fine">
            <a href={`/s?url=${encodeURIComponent(exampleUrl)}`} className="hg-link">
              {preview.tryExample}
            </a>{' '}
            {preview.exampleNote}
          </p>
        </form>
        {result ? <Result r={result} /> : null}
      </div>
    </div>
  );
}

function Result({ r }: { r: PreviewResult }) {
  if (r.ok) return <Landing v={r.view} />;
  const e = preview.errors[r.kind];
  return (
    <section className="hg-pv-error" role="alert" aria-labelledby="pv-error-title" data-error={r.kind}>
      <p className="hg-kicker">{preview.errors.heading}</p>
      <h2 id="pv-error-title">{e.title}</h2>
      <p>{e.detail}</p>
      {r.kind === 'too_large' ? <p className="hg-fine">{capsText()}</p> : null}
      {r.kind === 'invalid' && r.issues.length ? (
        <ul className="hg-pv-issues">
          {r.issues.map((i, k) => (
            <li key={k}>
              {i.path ? <code>{i.path}</code> : null} {i.message}
            </li>
          ))}
        </ul>
      ) : r.message ? (
        <p className="hg-fine">{r.message}</p>
      ) : null}
    </section>
  );
}

function Inline({ text, images }: { text: string; images: Record<string, string> }) {
  return (
    <>
      {parsePreviewInline(text, (src) => images[src] ?? null).map((s, i) => {
        switch (s.t) {
          case 'code':
            return <code key={i}>{s.v}</code>;
          case 'strong':
            return <strong key={i}>{s.v}</strong>;
          case 'link':
            return (
              <a key={i} href={s.href} rel="nofollow noopener noreferrer ugc" target="_blank">
                {s.v}
              </a>
            );
          case 'image':
            return <img key={i} src={s.src} alt={s.alt} className="hg-pv-inline-img" />;
          default:
            return <span key={i}>{s.v}</span>;
        }
      })}
    </>
  );
}

function BodyBlock({ b, images }: { b: Block; images: Record<string, string> }) {
  switch (b.type) {
    case 'heading':
      return b.level === 2 ? (
        <h3>
          <Inline text={b.text} images={images} />
        </h3>
      ) : (
        <h4>
          <Inline text={b.text} images={images} />
        </h4>
      );
    case 'paragraph':
      return (
        <p>
          <Inline text={b.text} images={images} />
        </p>
      );
    case 'list': {
      const items = b.items.map((it, i) => (
        <li key={i}>
          <Inline text={it.text} images={images} />
        </li>
      ));
      return b.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case 'code':
      return (
        <pre tabIndex={0}>
          <code>{b.text}</code>
        </pre>
      );
    case 'table':
      return (
        <div className="hg-table-wrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i}>
                    <Inline text={c} images={images} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((c, j) => (
                    <td key={j}>
                      <Inline text={c} images={images} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr />;
  }
}

function Landing({ v }: { v: PreviewView }) {
  const a = v.admission;
  const style = v.accent ? ({ '--hg-pv-accent': v.accent } as CSSProperties) : undefined;
  return (
    <article className="hg-pv" style={style} aria-labelledby="pv-title" data-henge-id={v.henge.id}>
      <header className="hg-pv-hero">
        {v.hero ? (
          <img src={v.hero} alt="" className="hg-pv-hero-img" />
        ) : null}
        <div className="hg-pv-head">
          {v.icon ? (
            <img src={v.icon} alt="" className="hg-pv-icon" width={64} height={64} />
          ) : (
            <span className="hg-pv-icon hg-pv-icon-blank" aria-hidden="true">
              {v.title.slice(0, 1)}
            </span>
          )}
          <div>
            <p className="hg-kicker">{preview.kicker}</p>
            <h2 id="pv-title" className="hg-pv-title">
              {v.title}
            </h2>
            <p className="hg-pv-tagline">{v.tagline}</p>
            <p className="hg-fine hg-pv-by">
              {preview.publishedBy}{' '}
              {v.henge.publisher.url && /^https:\/\//.test(v.henge.publisher.url) ? (
                <a href={v.henge.publisher.url} rel="nofollow noopener noreferrer ugc" target="_blank">
                  {v.henge.publisher.name}
                </a>
              ) : (
                v.henge.publisher.name
              )}{' '}
              <span className="hg-mono">{v.henge.id}</span>
            </p>
          </div>
        </div>
        <div className="hg-btn-row hg-pv-actions">
          <a href={v.deepLink} className="hg-btn hg-btn-lg hg-pv-open">
            {preview.openInHenge}
          </a>
          <p className="hg-fine">{preview.openNote}</p>
        </div>
      </header>

      <div className="hg-pv-grid">
        <div className="hg-pv-main">
          <section aria-labelledby="pv-about">
            <h3 id="pv-about">{preview.aboutHeading}</h3>
            <p className="hg-pv-summary">{v.henge.summary}</p>
            <p className="hg-pv-desc">{v.henge.description}</p>
          </section>

          {v.sections.length ? (
            <div className="hg-pv-cards">
              {v.sections.map((s, i) => (
                <div key={i} className="hg-card">
                  <h4>{s.title}</h4>
                  <p>{s.body}</p>
                </div>
              ))}
            </div>
          ) : null}

          {v.body ? (
            <div className="hg-doc hg-pv-body">
              {v.body.map((b, i) => (
                <BodyBlock key={i} b={b} images={v.bodyImages} />
              ))}
            </div>
          ) : null}
          {v.sanitized ? <p className="hg-fine">{preview.sanitizedNote}</p> : null}
          {v.bodyMissing && v.singleFile ? <p className="hg-fine">{preview.singleFileNote}</p> : null}

          {v.links.length ? (
            <section aria-labelledby="pv-links">
              <h3 id="pv-links">{preview.linksHeading}</h3>
              <ul className="hg-pv-links">
                {v.links.map((l, i) => (
                  <li key={i}>
                    {l.href ? (
                      <a href={l.href} rel="nofollow noopener noreferrer ugc" target="_blank">
                        {l.label}
                      </a>
                    ) : (
                      <>
                        {l.label} <span className="hg-fine">{preview.bundleOnly}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="pv-glyphs">
            <h3 id="pv-glyphs">{preview.glyphsHeading}</h3>
            {v.glyphs.length ? (
              <ul className="hg-pv-glyphs">
                {v.glyphs.map((g) => (
                  <li key={g.use} className="hg-card">
                    <p className="hg-mono hg-pv-glyph-use">{g.use}</p>
                    {!g.checked ? <p className="hg-fine">{preview.glyphUnchecked}</p> : null}
                    {g.granted.length ? (
                      <>
                        <p className="hg-runes-label">{preview.grantedLabel}</p>
                        <ul className="hg-runes">
                          {g.granted.map((s) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {g.runes.length ? (
                      <>
                        <p className="hg-runes-label">{preview.runesLabel}</p>
                        <ul className="hg-runes">
                          {g.runes.map((s) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hg-p">{preview.noGlyphs}</p>
            )}
          </section>
        </div>

        <aside className="hg-pv-side">
          <section aria-labelledby="pv-admission" className="hg-card">
            <h3 id="pv-admission">{preview.admissionHeading}</h3>
            <dl className="hg-pv-dl">
              <dt>{preview.admission.mode}</dt>
              <dd>{preview.admission.modes[a.mode]}</dd>
              <dt>{preview.admission.identity}</dt>
              <dd>{a.identity.join(', ')}</dd>
              <dt>{preview.admission.minClient}</dt>
              <dd className="hg-mono">{a.requirements.min_client_version}</dd>
              {a.requirements.qualification ? (
                <>
                  <dt>{preview.admission.qualification}</dt>
                  <dd>{preview.admission.qualificationText(a.requirements.qualification.pass, a.requirements.qualification.tasks)}</dd>
                </>
              ) : null}
              {a.review?.by?.length ? (
                <>
                  <dt>{preview.admission.reviewBy}</dt>
                  <dd>{a.review.by.join(', ')}</dd>
                </>
              ) : null}
              {a.capacity ? (
                <>
                  <dt>{preview.admission.capacity}</dt>
                  <dd>{typeof a.capacity.max_members === 'number' ? preview.admission.maxMembers(a.capacity.max_members) : preview.admission.noCap}</dd>
                </>
              ) : null}
              {a.leave ? (
                <>
                  <dt>{preview.admission.leave}</dt>
                  <dd>{a.leave.allowed === false ? preview.admission.leaveNotAllowed : preview.admission.leaveAllowed}</dd>
                </>
              ) : null}
            </dl>
            {a.requirements.attest?.length ? (
              <>
                <p className="hg-runes-label">{preview.admission.attest}</p>
                <ul className="hg-pv-attest">
                  {a.requirements.attest.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>

          <section aria-labelledby="pv-source" className="hg-card">
            <h3 id="pv-source">{preview.sourceHeading}</h3>
            <dl className="hg-pv-dl">
              <dt>{preview.sourceUrl}</dt>
              <dd className="hg-mono hg-pv-break" data-testid="pv-source-url">
                {v.url}
              </dd>
              <dt>{preview.version}</dt>
              <dd className="hg-mono">{v.henge.version}</dd>
              <dt>{preview.digest}</dt>
              <dd className="hg-mono hg-pv-break" data-testid="pv-digest">
                {v.pin.bundle_digest}
              </dd>
              {v.pin.commit ? (
                <>
                  <dt>{preview.commit}</dt>
                  <dd className="hg-mono hg-pv-break">{v.pin.commit}</dd>
                </>
              ) : null}
              {v.pin.etag ? (
                <>
                  <dt>{preview.etag}</dt>
                  <dd className="hg-mono hg-pv-break">{v.pin.etag}</dd>
                </>
              ) : null}
            </dl>
          </section>
        </aside>
      </div>
    </article>
  );
}
