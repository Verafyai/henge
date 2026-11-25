import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Chip, Footer, Header, Stepper } from './index';

const noDashes = (html: string) => expect(/[–—]/.test(html)).toBe(false);

describe('Chip', () => {
  it('always renders its text', () => {
    expect(renderToStaticMarkup(<Chip tone="approved">Approved</Chip>)).toContain('Approved');
  });
});

describe('Stepper', () => {
  it('links only completed steps', () => {
    const html = renderToStaticMarkup(
      <Stepper steps={[{ key: 'a', label: 'Basics', href: '/new/basics', state: 'done' }, { key: 'b', label: 'Spec', href: '/new/spec', state: 'current' }, { key: 'c', label: 'Swarm', href: '/new/swarm', state: 'upcoming' }]} />,
    );
    expect(html).toContain('href="/new/basics"');
    expect(html).not.toContain('href="/new/swarm"');
    expect(html).toContain('aria-current="step"');
  });
});

describe('copy rules', () => {
  it('chrome components have no em or en dashes', () => {
    noDashes(renderToStaticMarkup(<Header />));
    noDashes(renderToStaticMarkup(<Footer />));
  });
  it('header and footer make no income or token claims (SPEC 9.4, 9.7)', () => {
    for (const html of [renderToStaticMarkup(<Header />), renderToStaticMarkup(<Footer />)]) {
      const text = html.replace(/<[^>]+>/g, ' ');
      // The footer may state what is NOT offered; check affirmative phrasing only.
      expect(text.replace(/cannot be cashed out or transferred/, '')).not.toMatch(/cash(ed)? out|side income|payout|withdraw/i);
    }
  });
  it('header is browse-only: no store purchase or propose actions', () => {
    const html = renderToStaticMarkup(<Header />);
    expect(html).toContain('Get Henge');
    expect(html).not.toMatch(/Propose|Back this|Buy/);
  });
});
