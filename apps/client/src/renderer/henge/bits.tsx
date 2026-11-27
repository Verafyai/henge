import type { ReactNode } from 'react';
import hengeMark from '../assets/henge-mark.svg';
import type { Member, Presence } from '../community/store';

export function Mark({ height, glow = false, className }: { height: number; glow?: boolean; className?: string }) {
  return <img src={hengeMark} alt="" aria-hidden="true" className={className} style={{ height, width: 'auto', filter: glow ? 'drop-shadow(0 0 24px rgba(255,42,61,.25))' : undefined }} />;
}

/** The Glyph icon: a rune stone. Drawn here, not taken from any other product. */
export function GlyphIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} style={{ flex: 'none' }} aria-hidden="true">
      <rect x="2" y="1.5" width="12" height="13" rx="3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4v8M8 6.2l2.6-1.6M8 9.4l-2.6-1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function GlyphTile({ size = 40 }: { size?: number }) {
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: size / 4, background: '#2a0f13', color: '#ff7a85', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
      <GlyphIcon size={Math.round(size * 0.55)} />
    </span>
  );
}

export function initialsOf(name: string): string {
  const parts = name
    .replace(/\(.*?\)/g, '')
    .split(/[\s/._-]+/)
    .filter(Boolean);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return parts
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/** Henge tints. Red stays reserved for selection, so it is not in the rotation. */
const TINTS: Array<[string, string]> = [
  ['#0f1d2a', '#8fb4ff'],
  ['#0e231d', '#3fd0a8'],
  ['#231c0e', '#e0b862'],
  ['#1a1430', '#b69cff'],
  ['#1a1b1e', '#c9ccd1'],
];
export function tintFor(seed: string): [string, string] {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

export const PRESENCE_COLOR: Record<Presence, string> = {
  online: 'var(--hg-ok)',
  running: 'var(--hg-ok)',
  idle: 'var(--hg-pending)',
  paused: 'var(--hg-pending)',
  dnd: 'var(--hg-accent)',
  offline: '#55575d',
};

export const PRESENCE_LABEL: Record<Presence, string> = { online: 'Online', running: 'Running', idle: 'Idle', paused: 'Paused', dnd: 'Do not disturb', offline: 'Offline' };

export function Avatar({ name, image, size = 32, presence, tint, ring = 'var(--hg-panel)' }: { name: string; image?: string | null; size?: number; presence?: Presence; tint?: [string, string]; ring?: string }) {
  const [bg, fg] = tint ?? tintFor(name);
  return (
    <span className="hg-av" style={{ width: size, height: size, background: bg, color: fg, fontSize: Math.max(9, Math.round(size / 3)) }} aria-hidden="true">
      {image ? <img src={image} alt="" /> : initialsOf(name)}
      {presence && <span className="st" style={{ background: PRESENCE_COLOR[presence], borderColor: ring }} />}
    </span>
  );
}

export function KindTag({ m }: { m: Pick<Member, 'actorType'> | { actorType: 'glyph' } }) {
  if (m.actorType === 'agent') return <span className="hg-tag agent">agent</span>;
  if (m.actorType === 'glyph') return <span className="hg-tag glyph">glyph</span>;
  return <span className="hg-tag human">human</span>;
}

export function Field({ label, children, hint, htmlFor }: { label: ReactNode; children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label className="hg-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className="hg-faint" style={{ fontSize: 12, marginTop: 6 }}>{hint}</div>}
    </div>
  );
}

export function Seg<T extends string>({ label, options, value, onChange }: { label: string; options: Array<{ value: T; label: string; disabled?: boolean; title?: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="hg-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} className="hg-toggle" onClick={() => onChange(!checked)} />;
}

export function Issues({ issues }: { issues: Array<{ message: string }> }) {
  if (!issues.length) return null;
  return (
    <ul role="alert" className="hg-error" style={{ display: 'grid', gap: 4, margin: 0, paddingLeft: 18 }}>
      {issues.map((i, n) => (
        <li key={n}>{i.message}</li>
      ))}
    </ul>
  );
}

export function BrandCorner() {
  return (
    <div className="hg-brand">
      <Mark height={34} />
      <span>HENGE</span>
    </div>
  );
}

export const fmtTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
export const fmtDay = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });
export function whenLabel(t: number, now = Date.now()): string {
  const d = new Date(t);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return `Today ${fmtTime.format(d)}`;
  if (same(d, yesterday)) return `Yesterday ${fmtTime.format(d)}`;
  return `${fmtDay.format(d)} ${fmtTime.format(d)}`;
}
