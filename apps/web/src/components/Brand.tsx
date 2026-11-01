import {
  BadgeCheck, ClipboardCheck, FilePen, Info, PenLine, type LucideIcon,
} from 'lucide-react';
import type { TaskKind } from '../types';

/** Sigla SeaDoc: o pagină cu două valuri. Decorativă; numele produsului apare mereu lângă ea. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#0e6e78" />
      <path d="M10.5 6.5h7.6l4.9 4.9V24a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 9 24V8a1.5 1.5 0 0 1 1.5-1.5z" fill="#fff" />
      <path d="M11.8 16.2c1.2-1.2 2.4-1.2 3.6 0s2.4 1.2 3.6 0M11.8 20.4c1.2-1.2 2.4-1.2 3.6 0s2.4 1.2 3.6 0" fill="none" stroke="#0e6e78" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const TASK_ICONS: Record<TaskKind, LucideIcon> = {
  avizare: ClipboardCheck,
  aprobare: BadgeCheck,
  semnare: PenLine,
  informare: Info,
  completare: FilePen,
};

/** Pictograma tipului de sarcină, într-un chenar colorat. Textul tipului apare separat. */
export function TaskIcon({ kind, tone = 'primary' }: { kind: TaskKind; tone?: 'primary' | 'danger' }) {
  const Icon = TASK_ICONS[kind] ?? Info;
  return <span className={`icon-chip icon-chip-${tone}`} aria-hidden="true"><Icon size={18} /></span>;
}
