import type { ComponentType } from 'react';
import type { EditDto, VersionDto } from '@/lib/shared/studio-dto';

/** Asks the Studio to reload its status (and to poll faster when work was just started). */
export type StudioRefresh = (options?: { expectBusy?: boolean }) => void;

/** What every edit-card slot receives. */
export interface EditCardSlotProps {
  edit: EditDto;
  /** The version the card is showing (the current one), or null while none exists. */
  version: VersionDto | null;
  onChanged: StudioRefresh;
}

/**
 * A module's additions to each preview card in the Video Studio. Every slot is optional and renders nothing when the
 * module has nothing to say. Slots must keep touch targets at least 44 px and fit a 390 px wide phone screen.
 */
export interface EditCardExtension {
  /** Module name, used as the React key. */
  id: string;
  /** Small badges beside the style name (e.g. "Posted to Instagram"). */
  Badges?: ComponentType<EditCardSlotProps>;
  /** A message under the description (e.g. a music licence warning). */
  Banner?: ComponentType<EditCardSlotProps>;
  /** Extra buttons in the card's action row (e.g. "Publish…", "Hide this edit"). */
  MenuItems?: ComponentType<EditCardSlotProps>;
}
