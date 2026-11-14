'use client';

import { doTheseFirst, type Finding } from '@studio/core';
import { FindingCard, type AltImage } from './finding-card';

/** "Do these first": up to five findings of at least "Worth doing", in priority order (design §6.4). No score is shown. */
export function PriorityList({
  findings,
  changeKeys,
  onShowChange,
  altImages,
}: {
  findings: Finding[];
  changeKeys: Set<string>;
  onShowChange: () => void;
  altImages?: AltImage[];
}) {
  const top = doTheseFirst(findings);
  if (top.length === 0) return null;
  return (
    <section className="space-y-2" aria-labelledby="do-these-first">
      <h3 id="do-these-first" className="text-sm font-semibold text-charcoal-900">
        Do these first
      </h3>
      <div className="space-y-2">
        {top.map((f, i) => (
          <FindingCard key={f.key} finding={f} hasChange={changeKeys.has(f.key)} onShowChange={onShowChange} defaultOpen={i === 0} altImages={altImages} />
        ))}
      </div>
    </section>
  );
}
