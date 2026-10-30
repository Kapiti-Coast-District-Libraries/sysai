import { library } from '../supabase/functions/_shared/library';

// The library details anyone can change for themselves on the Settings page
// (settings.html). Each person's changes are saved in their own row of the
// user_settings table and only change their own chats. Anything they haven't
// changed comes from supabase/functions/_shared/library.ts, which also keeps
// the details needed before anyone signs in (the Supabase project, the site
// address, the guides repo).

export type Branch = { name: string; code: string };
export type Contact = { name: string; covers: string };

export type LibrarySettings = {
  name: string;
  shortName: string;
  institution: { code: string; name: string };
  sharedWith: string[];
  branches: Branch[];
  spydus: { version: string; helpVersion: string };
  systems: string[];
  contacts: { intro: string; list: Contact[] };
  printer: { tonerColours: string[]; cartridge: string };
};

export const DEFAULT_SETTINGS: LibrarySettings = {
  name: library.name,
  shortName: library.shortName,
  institution: library.institution,
  sharedWith: library.sharedWith,
  branches: library.branches,
  spydus: library.spydus,
  systems: library.systems,
  contacts: library.contacts,
  printer: library.printer,
};

let current = DEFAULT_SETTINGS;

export const librarySettings = (): LibrarySettings => current;

// Called with the library column of the person's user_settings row, if any.
export function applySavedSettings(saved: unknown): void {
  current = withDefaults(saved);
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const textList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length > 0 && value.every(isText) ? value : null;
const pairList = <K extends string>(value: unknown, keys: [K, K]): Record<K, string>[] | null =>
  Array.isArray(value) && value.length > 0 && value.every((item) => item && keys.every((k) => isText(item[k])))
    ? value.map((item) => ({ [keys[0]]: item[keys[0]], [keys[1]]: item[keys[1]] }) as Record<K, string>)
    : null;

// Each saved value is used only if it's the right shape, so a bad save can't
// break the chat; the default fills in anything missing.
export function withDefaults(saved: unknown): LibrarySettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, any>;
  const d = DEFAULT_SETTINGS;
  return {
    name: isText(s.name) ? s.name : d.name,
    shortName: isText(s.shortName) ? s.shortName : d.shortName,
    institution: {
      code: isText(s.institution?.code) ? s.institution.code : d.institution.code,
      name: isText(s.institution?.name) ? s.institution.name : d.institution.name,
    },
    // Can be empty: a library with its own database shares it with no one.
    sharedWith: Array.isArray(s.sharedWith) && s.sharedWith.every(isText) ? s.sharedWith : d.sharedWith,
    branches: pairList(s.branches, ['name', 'code']) ?? d.branches,
    spydus: {
      version: isText(s.spydus?.version) ? s.spydus.version : d.spydus.version,
      helpVersion: isText(s.spydus?.helpVersion) ? s.spydus.helpVersion : d.spydus.helpVersion,
    },
    systems: Array.isArray(s.systems) && s.systems.every(isText) ? s.systems : d.systems,
    contacts: {
      intro: isText(s.contacts?.intro) ? s.contacts.intro : d.contacts.intro,
      list: pairList(s.contacts?.list, ['name', 'covers']) ?? d.contacts.list,
    },
    printer: {
      tonerColours: textList(s.printer?.tonerColours) ?? d.printer.tonerColours,
      cartridge: isText(s.printer?.cartridge) ? s.printer.cartridge : d.printer.cartridge,
    },
  };
}
