import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Metadata } from 'next';
import { spec } from '@/lib/henge-landing-copy';
import { type Block, parseInline, parseMarkdown } from '@/lib/mini-markdown';

export const metadata: Metadata = { title: spec.title };

/** Sections 6 and 7 of the Henge spin-out spec v2, copied verbatim into content/henge-spec.md. */
export default async function SpecPage() {
  const source = await readFile(path.join(process.cwd(), 'content', 'henge-spec.md'), 'utf8');
  const blocks = parseMarkdown(source);
  return (
    <div className="hg-page">
      <div className="hg-wrap">
        <p className="hg-kicker">{spec.kicker}</p>
        <h1 className="hg-h1-page">{spec.h1}</h1>
        <p className="hg-p">{spec.p}</p>
        <div style={{ marginTop: 24 }}>
          <a href={spec.source.href} className="hg-btn hg-btn-ghost">
            {spec.source.label}
          </a>
        </div>
        <article className="hg-doc">
          {blocks.map((b, i) => (
            <MdBlock key={i} b={b} />
          ))}
        </article>
      </div>
    </div>
  );
}

function Text({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((s, i) => (s.t === 'code' ? <code key={i}>{s.v}</code> : s.t === 'strong' ? <strong key={i}>{s.v}</strong> : <span key={i}>{s.v}</span>))}
    </>
  );
}

function MdBlock({ b }: { b: Block }) {
  switch (b.type) {
    case 'heading':
      return b.level === 2 ? (
        <h2 id={b.id}>
          <Text text={b.text} />
        </h2>
      ) : (
        <h3 id={b.id}>
          <Text text={b.text} />
        </h3>
      );
    case 'paragraph':
      return (
        <p>
          <Text text={b.text} />
        </p>
      );
    case 'list': {
      const items = b.items.map((it, i) => (
        <li key={i} className={it.task ? 'hg-task' : undefined}>
          <Text text={it.text} />
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
                {b.head.map((h, i) => (
                  <th key={i}>
                    <Text text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>
                      <Text text={c} />
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
