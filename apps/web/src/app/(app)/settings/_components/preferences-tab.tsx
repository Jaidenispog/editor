'use client';

import { useState, type FormEvent } from 'react';
import { STYLES, STYLE_IDS, type EditingPreferences, type StyleId } from '@studio/core';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card';
import { Input, Select, Textarea } from '@/components/ui/field';
import { useSaveSettings } from './use-save-settings';

/** Every EditingPreferences field with friendly controls; style affinity is shown as learned history. */
export function PreferencesTab({ preferences, disabled }: { preferences: EditingPreferences; disabled: boolean }) {
  const { save, saving, errors } = useSaveSettings('preferences');
  const [v, setV] = useState<EditingPreferences>(preferences);
  const [moodsText, setMoodsText] = useState(preferences.musicMoods.join(', '));
  const set = <K extends keyof EditingPreferences>(k: K, value: EditingPreferences[K]) => setV((s) => ({ ...s, [k]: value }));

  const toggleStyle = (id: StyleId) => set('preferredStyles', v.preferredStyles.includes(id) ? v.preferredStyles.filter((s) => s !== id) : [...v.preferredStyles, id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const musicMoods = moodsText
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
      .slice(0, 12);
    await save({ ...v, musicMoods });
  };

  const affinity = Object.entries(v.styleAffinity).filter(([, n]) => n > 0);

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card>
        <CardHeader title="Length and pacing" description="Starting points for every new generation. You can still change them per project." />
        <CardBody className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <label htmlFor="pref-duration" className="flex items-center justify-between text-sm font-medium text-charcoal-800">
              <span>Default length</span>
              <span className="tabular-nums text-charcoal-600">{v.defaultDurationSec} seconds</span>
            </label>
            <input
              id="pref-duration"
              type="range"
              min={8}
              max={90}
              step={1}
              value={v.defaultDurationSec}
              onChange={(e) => set('defaultDurationSec', Number(e.target.value))}
              disabled={disabled}
              className="w-full accent-[var(--accent)]"
            />
            <p className="text-sm text-charcoal-500">Between 8 and 90 seconds. Reels and TikTok both suit 15–30 seconds.</p>
          </div>
          <Select
            label="Pacing"
            value={v.pacing}
            onChange={(e) => set('pacing', e.target.value as EditingPreferences['pacing'])}
            disabled={disabled}
            options={[
              { value: 'slow', label: 'Slow — longer shots, calm' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'fast', label: 'Fast — quick cuts, energetic' },
            ]}
          />
          <Select
            label="Transitions"
            value={v.transitions}
            onChange={(e) => set('transitions', e.target.value as EditingPreferences['transitions'])}
            disabled={disabled}
            options={[
              { value: 'restrained', label: 'Restrained — cuts, fades and dissolves' },
              { value: 'varied', label: 'Varied — wipes, slides and zooms too' },
            ]}
          />
          <Select
            label="On-screen text"
            value={v.textDensity}
            onChange={(e) => set('textDensity', e.target.value as EditingPreferences['textDensity'])}
            disabled={disabled}
            options={[
              { value: 'none', label: 'None' },
              { value: 'light', label: 'Light — a title or two' },
              { value: 'medium', label: 'Medium — titles and labels' },
            ]}
          />
          <Select
            label="Colour"
            value={v.colour}
            onChange={(e) => set('colour', e.target.value as EditingPreferences['colour'])}
            disabled={disabled}
            options={[
              { value: 'natural', label: 'Natural — true to the shop lighting' },
              { value: 'clean', label: 'Clean — bright and neutral' },
              { value: 'cinematic', label: 'Cinematic — moodier contrast' },
              { value: 'punchy', label: 'Punchy — richer colour' },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Favourite styles" description="Ticked styles are chosen first when you generate edits." />
        <CardBody>
          <fieldset disabled={disabled}>
            <legend className="sr-only">Favourite styles</legend>
            <ul className="grid gap-3 md:grid-cols-2">
              {STYLE_IDS.map((id) => {
                const style = STYLES[id];
                const checked = v.preferredStyles.includes(id);
                return (
                  <li key={id}>
                    <label className="flex cursor-pointer gap-3 rounded-xl border border-charcoal-200 p-4 has-[:checked]:border-charcoal-900 has-[:checked]:bg-charcoal-50">
                      <input type="checkbox" checked={checked} onChange={() => toggleStyle(id)} className="mt-0.5 size-4 accent-[var(--accent)]" />
                      <span>
                        <span className="block text-sm font-medium text-charcoal-900">{style.name}</span>
                        <span className="mt-0.5 block text-sm text-charcoal-500">{style.shortDescription}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          {affinity.length ? (
            <div className="mt-5 rounded-lg bg-charcoal-50 px-4 py-3 text-sm text-charcoal-600">
              <p className="font-medium text-charcoal-800">Learned from your favourites and downloads</p>
              <p className="mt-1">
                {affinity
                  .sort((a, b) => b[1] - a[1])
                  .map(([id, n]) => `${(STYLES as Record<string, { name: string } | undefined>)[id]?.name ?? id} (${n})`)
                  .join(' · ')}
              </p>
              <button type="button" disabled={disabled} onClick={() => set('styleAffinity', {})} className="mt-2 text-sm font-medium text-charcoal-800 underline underline-offset-4 disabled:opacity-50">
                Reset learned history
              </button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Sound and captions" />
        <CardBody className="grid gap-5 sm:grid-cols-2">
          <Select
            label="Original sound from clips"
            value={v.keepOriginalSound}
            onChange={(e) => set('keepOriginalSound', e.target.value as EditingPreferences['keepOriginalSound'])}
            disabled={disabled}
            options={[
              { value: 'auto', label: 'Automatic — keep speech and clean clipper sounds' },
              { value: 'always', label: 'Always keep, under the music' },
              { value: 'never', label: 'Never — music only' },
            ]}
          />
          <Select
            label="Captions"
            value={v.captions}
            onChange={(e) => set('captions', e.target.value as EditingPreferences['captions'])}
            disabled={disabled}
            hint="Captions only ever use words actually spoken in your clips."
            options={[
              { value: 'auto', label: 'Automatic when someone speaks' },
              { value: 'never', label: 'Never' },
            ]}
          />
          <div className="space-y-1.5">
            <label htmlFor="pref-volume" className="flex items-center justify-between text-sm font-medium text-charcoal-800">
              <span>Music volume</span>
              <span className="tabular-nums text-charcoal-600">{Math.round(v.musicVolume * 100)}%</span>
            </label>
            <input
              id="pref-volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={v.musicVolume}
              onChange={(e) => set('musicVolume', Number(e.target.value))}
              disabled={disabled}
              className="w-full accent-[var(--accent)]"
            />
          </div>
          <Input
            label="Music moods you like"
            value={moodsText}
            onChange={(e) => setMoodsText(e.target.value)}
            disabled={disabled}
            placeholder="e.g. hip hop, chill, upbeat"
            hint="Separate with commas. Used to suggest tracks from your own library."
            error={errors['musicMoods'] ?? null}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Standing instructions" description="Notes every edit should respect, in your own words." />
        <CardBody>
          <Textarea
            label="Instructions"
            hideLabel
            value={v.standingInstructions}
            onChange={(e) => set('standingInstructions', e.target.value)}
            maxLength={1000}
            rows={4}
            disabled={disabled}
            placeholder="e.g. Always finish on the final look for at least two seconds. Keep text away from faces."
            error={errors['standingInstructions'] ?? null}
            hint={`${v.standingInstructions.length}/1000 characters`}
          />
        </CardBody>
        <CardFooter>
          <Button type="submit" loading={saving} disabled={disabled}>
            Save preferences
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
