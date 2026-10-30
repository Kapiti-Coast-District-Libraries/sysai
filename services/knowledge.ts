// Picks the parts of the LibSysAIKB knowledge base that are relevant to a
// staff question, so the chat sends the AI a few focused excerpts instead of
// whole guides. Guides are split into sections when they load; each question
// is matched against those sections with BM25 ranking.

import { LKP, LKPTable, VQD } from '../types';
import { booleanMandate, printerInstruction, REPLY_RULES } from '../constants';
import { librarySettings } from './settings';

export type ChatTurn = { role: 'user' | 'model'; content: string };

export type GuideChunk = {
  guide: string;
  source: string;
  version: string | null;
  heading: string;
  text: string;
  path: string;
};

type IndexedChunk = GuideChunk & {
  position: number;
  terms: Map<string, number>;
  length: number;
  titleTerms: Set<string>;
  headingTerms: Set<string>;
  setup: boolean;
};

export type GuideIndex = {
  chunks: IndexedChunk[];
  docFreq: Map<string, number>;
  avgLength: number;
  guides: number;
};

export type RequestKind = 'ink' | 'boolean' | 'general';

// ---------- Reading the guides ----------

const MAX_CHUNK_CHARS = 1600;
// Short neighbouring sections (FAQ answers, single settings) are kept together.
const MERGE_BELOW_CHARS = 900;

// Pages that matched almost everything without answering anything.
const SKIP_FILES = /(^|\/)(webindex|websearch)\.html$/i;

const SOURCES: [RegExp, string][] = [
  [/^SOP\/SPYDUS HELP SOPS\//i, 'Spydus Help'],
  [/^SOP\/Monitor\//i, 'APNK Monitor guide'],
  [/^SOP\/APNK\//i, 'APNK guide'],
  [/^SOP\/Bibliotheca\//i, 'Bibliotheca guide'],
];

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®',
  trade: '™', bull: '•', middot: '·', rarr: '→', larr: '←', times: '×',
};

const HEADING_MARK = '\u0001';

const BOILERPLATE_LINE = /^(collapse all|expand all|in this topic|see also|spydus help|\||©.*)$/i;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function htmlToLines(html: string): string[] {
  const text = decodeEntities(
    html
      .replace(/<h[1-6][^>]*>/gi, `\n${HEADING_MARK}`)
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<t[dh][^>]*>/gi, ' | ')
      .replace(/<(br|\/p|\/div|\/tr|\/table|\/ul|\/ol|\/li|\/dt|\/dd)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
  return text.split('\n').map((line) => line.replace(/[ \t ]+/g, ' ').trim());
}

type Section = { heading: string; lines: string[] };

function linesToSections(lines: string[]): Section[] {
  const sections: Section[] = [{ heading: '', lines: [] }];
  for (const line of lines) {
    if (line.startsWith(HEADING_MARK)) {
      const heading = line.slice(1).trim();
      if (heading) sections.push({ heading, lines: [] });
      continue;
    }
    if (!line || BOILERPLATE_LINE.test(line) || /^(\|\s*)+$/.test(line)) continue;
    sections[sections.length - 1].lines.push(line);
  }
  return sections.filter((s) => s.lines.length > 0);
}

// Splits text into pieces no longer than MAX_CHUNK_CHARS, breaking between lines
// where possible.
function splitLong(lines: string[]): string[] {
  const pieces: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = '';
  };
  for (let line of lines) {
    while (line.length > MAX_CHUNK_CHARS) {
      push();
      const cut = line.lastIndexOf(' ', MAX_CHUNK_CHARS);
      const at = cut > MAX_CHUNK_CHARS / 2 ? cut : MAX_CHUNK_CHARS;
      pieces.push(line.slice(0, at).trim());
      line = line.slice(at);
    }
    if (current.length + line.length + 1 > MAX_CHUNK_CHARS) push();
    current += (current ? '\n' : '') + line;
  }
  push();
  return pieces;
}

// Text copies of PDF guides have no heading markup, but their table of
// contents repeats each heading, so a short title-like line that appears more
// than once starts a section.
function textToSections(raw: string): Section[] {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const isHeading = (line: string) =>
    (counts.get(line) ?? 0) > 1 && line.length >= 4 && line.length <= 60 && /^[A-Z]/.test(line) && !/[.:,;]$/.test(line);

  const sections: Section[] = [{ heading: '', lines: [] }];
  for (const line of lines) {
    if (isHeading(line)) sections.push({ heading: line, lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections.filter((section) => section.lines.length > 0);
}

// Tables of contents and index pages list headings, so they match lots of
// questions but answer none. They're short lines with no sentences, unlike
// tables (| cells) and posters or quick guides (short instructions), or
// they repeat the guide's own headings.
function looksLikeContents(text: string, linesInGuide: Map<string, number>): boolean {
  const lines = text.split('\n');
  if (lines.length < 12) return false;
  const share = (test: (line: string) => boolean) => lines.filter(test).length / lines.length;
  if (share((l) => /^\d+(\.\d+)*\s.+\s\d{1,3}$/.test(l)) > 0.4) return true;
  if (text.length / lines.length >= 28 || share((l) => l.includes('|')) > 0.3) return false;
  const sentences = share((l) => /[.:?!]\s*$|[.:]\s/.test(l));
  const repeated = share((l) => (linesInGuide.get(l) ?? 0) > 1);
  return sentences < 0.15 || (repeated > 0.6 && sentences < 0.3);
}

export function parseGuide(name: string, path: string, raw: string): GuideChunk[] {
  if (SKIP_FILES.test(path)) return [];
  const source = SOURCES.find(([pattern]) => pattern.test(path))?.[1] ?? 'Guide';

  let title = name.replace(/\.[^.]+$/, '').replace(/\+/g, ' ');
  let version: string | null = name.match(/\bv(\d+(\.\d+)+)\b/i)?.[1] ?? null;
  let sections: Section[];

  if (/\.html?$/i.test(name)) {
    const html = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, '');
    const pageTitle = decodeEntities(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
    // Pages saved from behind a sign-in screen have no guide content.
    if (/log in with atlassian/i.test(pageTitle)) return [];
    if (pageTitle) title = pageTitle;
    version = html.match(/Version:\s*(\d{4}R\d+(\.\d+)?)/)?.[1] ?? version;

    const start = html.match(/<[^>]*id="i-body-content"[^>]*>/i);
    const end = html.search(/<[^>]*id="i-footer-content"/i);
    const from = start ? start.index! + start[0].length : 0;
    const body = html.slice(from, end > from ? end : undefined);
    sections = linesToSections(htmlToLines(body));
  } else {
    sections = textToSections(raw);
  }

  const linesInGuide = new Map<string, number>();
  for (const section of sections) {
    for (const line of [section.heading, ...section.lines]) {
      if (line) linesInGuide.set(line, (linesInGuide.get(line) ?? 0) + 1);
    }
  }

  const chunks: GuideChunk[] = [];
  for (const section of sections) {
    const heading = section.heading === title ? '' : section.heading;
    for (const text of splitLong(section.lines)) {
      if (looksLikeContents(text, linesInGuide)) continue;
      const previous = chunks[chunks.length - 1];
      if (previous && previous.text.length + text.length < MERGE_BELOW_CHARS) {
        previous.text += `\n\n${heading ? `${heading}\n` : ''}${text}`;
        // Keep every heading, so "Set a claims returned status" can still be
        // found when it's merged under "Set a damaged status".
        if (heading && !previous.heading.includes(heading)) {
          previous.heading = previous.heading ? `${previous.heading} · ${heading}` : heading;
        }
        continue;
      }
      chunks.push({ guide: title, source, version, heading, text, path });
    }
  }
  return chunks;
}

// ---------- Matching words ----------

const STOPWORDS = new Set(
  `a an and are as at be been being but by can could do does did doing for from had has have how i if in into is it
  its me my no not of on or our please so than that the their them then there these they this to too up us was we
  were what when where which who why will with would you your also just get got any all some about after before
  again very want need like know thanks thank hi hello hey im ive dont doesnt cant isnt wont there here its one
  way use using able keep still now help query queries question problem wondering
  u ur pls plz ok okay yes yeah yep nah nope huh hmm um uh sure really actually maybe guess best idea ideas think
  else other another more try tried work worked working didnt wasnt anything something tell give mean sorry
  because everyone everybody someone somebody anyone anybody thing things stuff say says said saying`.split(/\s+/),
);

// Words staff use that the guides say differently.
const PHRASES: [RegExp, string][] = [
  // "No internet" or "Spydus is down" at the desk means working offline.
  [/\b(no|lost|without|dropped)\s+(internet|network|wifi|connection)\b|\b(internet|network|spydus|system|server)\s+(is\s+|has\s+gone\s+|went\s+)?(down|out|offline)\b/g, '$& offline'],
  [/\bself[\s-]*(check(\s*out)?|issue|service|return)s?\b/g, 'selfcheck'],
  [/\b(log|sign)(s|ged|ging)?[\s-]*(in|on|into|onto)\b/g, 'login'],
  // Staff say "holds"; Spydus Help says "reservations".
  [/\b(plac|put|mak|add)\w*\s+(an?\s+)?holds?\b|\bholds\b/g, '$& reservation'],
  // A borrower's PIN is their password in Spydus.
  [/\bpins?\b/g, '$& password'],
  [/\bwi[\s-]*fi\b/g, 'wifi'],
  [/\bcheck[\s-]+out\b/g, 'checkout'],
  [/\bcheck[\s-]+in\b/g, 'checkin'],
  [/\bstaff\s*connect\b/g, 'staffconnect'],
  [/\bcirc\b/g, 'circulation'],
  // One word, so it doesn't match supplier "claims" in Acquisitions.
  [/\bclaim(s|ed)? (returned|never borrowed)\b/g, '$& claims$2'],
  // "Record" is in most guides, so match the phrase.
  [/\brecords? (is |are |was |were )?(still )?lock(ed|ing)\b/g, '$& recordlock'],
];

// How staff describe a situation, followed by what the guides call it. Only
// used on questions: in the guides themselves, words like "parent" and "child"
// are about catalogue records.
const STAFF_WORDING: [RegExp, string][] = [
  [/\b(says?|said|swears?|insists?|claims?|claimed)\b[^.?!]{0,40}\b(returned|brought (it |them )?back|handed (it |them )?in)\b/g, '$& claimsreturned'],
  // Set the same way as Claims Returned, on the borrower's loans.
  [/\bnever (borrowed|had|took)\b/g, '$& claimsreturned edit item status'],
  [/\b(parents?|mum|mom|dad|guardians?|caregivers?)\b/g, '$& head family'],
  [/\b(child|children|kids?|son|daughter)s?\b/g, '$& dependant'],
  [/\b(wipe|erase|delete|remove)\w*\b[^.?!]{0,40}\b(personal|data|details|info(rmation)?)\b|\bpersonal (info(rmation)?|data|details)\b|\bprivacy\b|\bforgotten\b/g, '$& forgotten resign'],
  [/\b(\d[\s-]*digit|verification|security|authenticat\w*) codes?\b|\bauthenticator\b|\b2fa\b|\btwo[\s-]*(factor|step)\b/g, '$& two factor authentication'],
  [/\bwho (had|has had|borrowed|took|checked out)\b|\b(previous|past|earlier) (borrowers?|loans?)\b|\bborrowed (it |this |that )?before\b/g, '$& issue return history'],
  [/\b(top|front|start) of the (holds?|reservations?|waiting|queue|list)\b|\bbump\w*\b|\bjump the queue\b/g, '$& amend reservation queue'],
  [/\bpop(s|ped)?[\s-]*up\b|\bred (box|screen|message|warning)\b/g, '$& alert'],
  [/\b(used|read|browsed?)\b[^.?!]{0,30}\b(in the library|in-?house|on site)\b|\bwithout borrowing\b|\bdidn'?t borrow\b/g, '$& inhouse'],
  [/\b(security )?gates?\b|\balarms?\b|\bbeep\w*\b/g, '$& security secure unsecure'],
  [/\b(discs?|disks?|cds?|dvds?)\b[^.?!]{0,40}\b(missing|set)\b|\bbox[\s-]?sets?\b/g, '$& box set partial'],
  [/\b(own|personal|their|my) (laptop|device|phone|tablet|computer)s?\b|\bbyod\b/g, '$& own device byod'],
  [/\b(more|extra|additional) time\b|\btime (ran|runs|has run|is running) out\b/g, '$& extend session'],
  // Loans already out are moved with Bulk Change Due Date. The holiday
  // settings only change due dates for new loans.
  [/\b(library|branch|we'?re|we are|were) (is |are )?(closed|closing|shut)\b|\bclosures?\b/g, '$& bulk change due date'],
  [/\b(push|move|extend|change)\w*\b[^.?!]{0,30}\bdue dates?\b/g, '$& bulk change due date'],
  [/\bsign(ed|ing)?[\s-]*up\b|\bnew (member|customer)s?\b|\benrol\w*\b/g, '$& register new borrower'],
  [/\b(no|without( a)?|hasn'?t got( a)?|doesn'?t have( a)?) (library )?card\b|\bvisitors?\b|\btourists?\b/g, '$& guest pass'],
  [/\b(came|come|comes|brought|bring|handed) (it |them )?(back|in)\b/g, '$& return'],
  [/\b(clear|remove|lift|delete|get rid of)\w*\b[^.?!]{0,20}\btraps?\b|\btraps?\b.{0,60}\b(clear|remove|lift)\w*\b/g, '$& manage traps'],
  [/\b(lost|stolen|replace\w*) (their |a |the |my )?(library )?cards?\b|\bnew (library )?cards?\b/g, '$& renumber'],
  [/\b(locked|in use|open) by (another|other|someone|a different)\b/g, '$& recordlock'],
];

const RELATED_WORDS = [
  'internet network connection connect online offline wifi',
  'selfcheck kiosk bibliotheca staffconnect',
  'rfid tag',
  'print printer',
  'toner ink cartridge',
  'chromebook chromestation chromebox chrome apnk',
  'borrower patron customer member',
  'reservation hold reserve',
  'issue loan checkout',
  'return checkin discharge',
  'renew renewal',
  'fine fee charge owe owing debt outstanding',
  'login logon password',
  'pc computer workstation device',
  'note message',
];

function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && /(sh|ch|x|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

// "Ōtaki" and "Otaki" match each other.
function withoutMacrons(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function terms(text: string, isQuestion = false): string[] {
  let lower = withoutMacrons(text.toLowerCase()).replace(/[’']/g, '');
  for (const [pattern, replacement] of PHRASES) lower = lower.replace(pattern, replacement);
  if (isQuestion) for (const [pattern, replacement] of STAFF_WORDING) lower = lower.replace(pattern, replacement);
  return lower
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
    .map(stem)
    // "wants", "tried"
    .filter((w) => !STOPWORDS.has(w));
}

const RELATED = new Map<string, string[]>();
for (const group of RELATED_WORDS) {
  const stems = group.split(' ').map(stem);
  for (const s of stems) RELATED.set(s, stems.filter((other) => other !== s));
}

// ---------- Index and search ----------

export function buildGuideIndex(chunks: GuideChunk[]): GuideIndex {
  const docFreq = new Map<string, number>();
  let totalLength = 0;
  const positions = new Map<string, number>();

  const indexed = chunks.map((chunk) => {
    const counts = new Map<string, number>();
    const words = terms(chunk.text);
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    const titleTerms = new Set(terms(`${chunk.guide} ${chunk.source}`));
    const headingTerms = new Set(terms(chunk.heading));
    for (const t of new Set([...counts.keys(), ...titleTerms, ...headingTerms])) {
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
    totalLength += words.length;
    const position = positions.get(chunk.path) ?? 0;
    positions.set(chunk.path, position + 1);
    const opening = chunk.text.slice(0, 300);
    const setup = ADMIN_PAGE.test(chunk.guide) || (SETTING_INTRO.test(opening) && /select Maintenance\b|Maintenance >/.test(chunk.text));
    return { ...chunk, position, terms: counts, length: words.length, titleTerms, headingTerms, setup };
  });

  return {
    chunks: indexed,
    docFreq,
    avgLength: totalLength / (indexed.length || 1),
    guides: positions.size,
  };
}

// Questions about these systems are answered by their own guides, not Spydus Help.
const SYSTEM_WORDS: [RegExp, string[]][] = [
  [/\b(monitor|guest pass(es)?|print (release|jobs?)|release (the |their )?print|public print|sessions?|(pc|computer) bookings?)\b/i, ['APNK Monitor guide']],
  [/\b(apnk|chrome ?(book|box|station|os)s?|public (computers?|pcs?|wifi))\b/i, ['APNK guide', 'APNK Monitor guide']],
  [/\b(bibliotheca|rfid|self[\s-]*(check|issue|return|service)|staff ?connect|kiosks?|security gates?|gates?|alarms?)\b/i, ['Bibliotheca guide']],
  [/\b(circ(ulation)?|front desk|spydus|staff (pc|computer)s?)\b/i, ['Spydus Help']],
];

// Setup and release-notes pages, which staff at the desk rarely need.
const ADMIN_PAGE = /html configurator|parameters?\b|container|\bapi\b|^\d{4}R\d|features in \d{4}R\d|maintenance$|rollover|invoices?\b|vendors?\b|\bPOs?\b|purchase orders?/i;
// Settings pages ("Maximum claimed returned loans") open with "To specify…"
// and steps from the Maintenance menu. Staff tasks done from there, like
// unlocking a record, don't.
const SETTING_INTRO = /\bTo (specify|set|define)\b|inherit the setting|\bYou can use the [^.]{0,60} parameter\b/;

type Ranked = { chunk: IndexedChunk; score: number; coverage: number };

export function rankGuides(
  index: GuideIndex,
  question: string,
  previousQuestion = '',
  prefer?: (path: string) => boolean,
): Ranked[] {
  const weights = new Map<string, number>();
  const add = (term: string, weight: number) => weights.set(term, Math.max(weights.get(term) ?? 0, weight));
  // A reply with nothing to search on ("huh, u sure?") is about the question before.
  if (terms(question, true).length === 0) [question, previousQuestion] = [previousQuestion, ''];
  const asked = [...new Set(terms(question, true))];
  const earlier = terms(previousQuestion, true);
  // Guide wording added for how staff put it ("swears they returned it" →
  // claims returned) is the best clue to which guide answers the question.
  const ownWords = new Set(terms(question));
  for (const t of asked) add(t, ownWords.has(t) ? 1 : 1.5);
  for (const t of asked) for (const r of RELATED.get(t) ?? []) add(r, 0.4);
  // Follow-ups like "what about the staff pad" lean on the question before.
  for (const t of earlier) add(t, asked.length <= 4 ? 0.6 : 0.3);
  if (weights.size === 0) return [];

  const k1 = 1.2;
  const b = 0.75;
  const n = index.chunks.length;
  const idf = new Map<string, number>();
  for (const t of weights.keys()) {
    const df = index.docFreq.get(t) ?? 0;
    idf.set(t, df === 0 ? 0 : Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }
  const askedIdf = asked.reduce((sum, t) => sum + (idf.get(t) ?? 0), 0);

  const systems = SYSTEM_WORDS.filter(([pattern]) => pattern.test(question)).flatMap(([, sources]) => sources);

  const ranked: Ranked[] = [];
  for (const chunk of index.chunks) {
    let score = 0;
    let matchedIdf = 0;
    for (const [t, weight] of weights) {
      const tIdf = idf.get(t)!;
      if (tIdf === 0) continue;
      const tf = chunk.terms.get(t) ?? 0;
      const inTitle = chunk.titleTerms.has(t);
      const inHeading = chunk.headingTerms.has(t);
      if (tf === 0 && !inTitle && !inHeading) continue;
      const body = tf === 0 ? 0 : (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * chunk.length) / index.avgLength));
      score += weight * tIdf * (body + (inTitle ? 1.2 : 0) + (inHeading ? 0.6 : 0));
      if (weight >= 1) matchedIdf += tIdf;
    }
    if (score === 0) continue;
    if (prefer?.(chunk.path)) score *= 1.6;
    if (systems.length > 0) score *= systems.includes(chunk.source) ? 1.5 : 0.6;
    if (chunk.setup) score *= 0.75;
    ranked.push({ chunk, score, coverage: askedIdf > 0 ? matchedIdf / askedIdf : 0 });
  }
  return ranked.sort((x, y) => y.score - x.score);
}

type SearchOptions = {
  maxChars?: number;
  maxChunks?: number;
  perGuide?: number;
  prefer?: (path: string) => boolean;
};

// Below this, the best match is a few common words in passing rather than a
// guide about the question.
const MIN_SCORE = 6;
// Share of the question's distinctive words a section has to contain, unless
// even the best match has fewer.
const MIN_COVERAGE = 0.45;

// Below this, even the best section leaves out most of what was asked.
const PARTIAL_COVERAGE = 0.5;

// earlierQuestion is set when this message doubts an earlier answer, or matched
// no guide, so the excerpts are the ones for the earlier question it's about.
export type Excerpts = { chunks: GuideChunk[]; partial: boolean; earlierQuestion?: string; doubting?: boolean };

export function searchGuides(
  index: GuideIndex,
  question: string,
  previousQuestion = '',
  { maxChars = 8000, maxChunks = 5, perGuide = 3, prefer }: SearchOptions = {},
): Excerpts {
  const ranked = rankGuides(index, question, previousQuestion, prefer);
  const top = ranked[0]?.score ?? 0;
  if (top < MIN_SCORE) return { chunks: [], partial: false };
  const minCoverage = Math.min(MIN_COVERAGE, ranked[0].coverage * 0.8);

  const picked: IndexedChunk[] = [];
  const perGuideCount = new Map<string, number>();
  let chars = 0;
  for (const { chunk, score, coverage } of ranked) {
    if (picked.length >= maxChunks || score < top * 0.4) break;
    if (coverage < minCoverage) continue;
    const count = perGuideCount.get(chunk.path) ?? 0;
    if (count >= perGuide || chars + chunk.text.length > maxChars) continue;
    picked.push(chunk);
    perGuideCount.set(chunk.path, count + 1);
    chars += chunk.text.length;
  }

  // Best guide first; sections of the same guide in their original order.
  const guideOrder = [...new Set(picked.map((c) => c.path))];
  const chunks = picked
    .sort((x, y) => guideOrder.indexOf(x.path) - guideOrder.indexOf(y.path) || x.position - y.position)
    .map(({ guide, source, version, heading, text, path }) => ({ guide, source, version, heading, text, path }));
  return { chunks, partial: ranked[0].coverage < PARTIAL_COVERAGE || missesRarestWord(index, question, previousQuestion, picked) };
}

// The question's most specific word, like "wifi" in "customer can't log into
// wifi" or "jammed", which no guide uses. If no section mentions it, the
// sections are probably about something else.
function missesRarestWord(index: GuideIndex, question: string, previousQuestion: string, picked: IndexedChunk[]) {
  // The guides never name the library or its branches.
  const places = new Set([...libraryWords(), ...branchNames()].map(stem));
  const asked = (terms(question, true).length > 0 ? terms(question, true) : terms(previousQuestion, true)).filter(
    (t) => !places.has(t),
  );
  if (asked.length === 0) return false;
  const df = (t: string) => index.docFreq.get(t) ?? 0;
  const rarest = asked.reduce((x, y) => (df(y) < df(x) ? y : x));
  // "customer" is matched by "borrower", "hold" by "reservation".
  const accepted = [rarest, ...(RELATED.get(rarest) ?? [])];
  return !picked.some((c) => accepted.some((t) => c.terms.has(t) || c.titleTerms.has(t) || c.headingTerms.has(t)));
}

export function formatExcerpts({ chunks, partial, earlierQuestion, doubting }: Excerpts): string {
  if (chunks.length === 0) {
    // Without the second sentence, the AI takes "no guide matched" to mean an
    // earlier answer was made up.
    return "### GUIDE EXCERPTS\nNo guide matched this message. That says nothing about earlier answers in this chat, which were based on the excerpts sent with them.";
  }
  const blocks = chunks.map((c) => {
    // The guide name on a line of its own, so the From: line doesn't copy the section names.
    const label = `Guide: ${c.guide}\n(${c.source}${c.version ? `, ${c.version}` : ''}${c.heading ? `, section: ${c.heading}` : ''})`;
    return `${label}\n${c.text}`;
  });
  const note = doubting
    ? `The staff member is questioning your earlier answer ("cap", "u sure?" and "prove it" mean they think it's wrong). These are the excerpts for their earlier question "${earlierQuestion}". Check the answer against them: stand by what they support, quoting the guide's words and naming it, and correct only what they don't.\n\n`
    : earlierQuestion
    ? `No guide matched this message on its own, so these are the excerpts for the earlier question "${earlierQuestion}", which it's probably about. If the staff member is checking or doubting an earlier answer, check it against these excerpts: stand by what they support and name the guide, and correct only what they don't. If it's a new question these don't cover, say the guides don't cover it.\n\n`
    : partial
      ? 'These are the closest matches, but they may only partly answer the question. Use what is relevant.\n\n'
      : '';
  return `### GUIDE EXCERPTS\n${note}${blocks.join('\n\n---\n\n')}`;
}

// ---------- What kind of request this is ----------

const INK_WORDS = /\b(ink|toner|cartridges?)\b/i;
// "How do I check the toner level?" is about the printer, not a request for toner.
const INK_TROUBLE = /\b(levels?|check\w*|install\w*|replac\w*|chang\w*|swap\w*|jam\w*|errors?|smudg\w*|streak\w*|leak\w*|fad\w*|lights?|stuck|won'?t|isn'?t|doesn'?t)\b/i;
const INK_QUESTIONS = /what colou?r toner|which library is this for/i;
const BOOLEAN_WORDS = /\bboolean\b|\bsearch (string|query)\b|\b(lkp|vqd)\b/i;
// "I have a query about…" is a question, not a Spydus query.
const QUERY_WORD = /\bquer(y|ies)\b/i;
const NOT_A_SPYDUS_QUERY =
  /\b(a|quick|small|general|another|some|any) quer(y|ies)\b|\bquer(y|ies) (about|regarding|re|on|from)\b|\b(has|have|had) quer(y|ies)\b/i;
// Spydus lookup codes ("location code", "code for Paraparaumu"), not error,
// QR, sign-in or wifi codes.
const CODE_WORD = /\b(location|status|collection|category|branch|item type|material|lookup|lkp)\s+codes?\b|\bcodes? (for|of)\b/i;
const NOT_A_LOOKUP_CODE = /\berror codes?\b|\bcode (error|message)\b|\bqr code\b|\b(\d[\s-]*digit|verification|security|login|access|authenticat\w*) codes?\b|\b(wi-?fi|password|door|alarm|pin|printer|photocopier|locker)\b/i;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isBooleanRequest(text: string): boolean {
  return (
    BOOLEAN_WORDS.test(text) ||
    (QUERY_WORD.test(text) && !NOT_A_SPYDUS_QUERY.test(text)) ||
    (CODE_WORD.test(text) && !NOT_A_LOOKUP_CODE.test(text))
  );
}

// "How do I waive a fine?" or "What does error E01 mean?" after a Boolean query
// is a new question.
const NEW_QUESTION = /^(how (do|can|to|would|should)|where (do|can|is)|can (i|you|we)|is there|what (does|do|is|are|should|happens)|why|who)\b/i;
// Words that change the query being worked on: "now only Waikanae", "make it
// 60 days", "lost items too".
const QUERY_CHANGE =
  /\b(only|instead|also|just|too|exclud\w*|includ\w*|without|except|add|remove|change|make it|same|but)\b|\d|\b(days?|weeks?|months?|years?|items?|borrowers?|loans?|reservations?|holds?|status\w*|locations?|collections?|categor\w*)\b/i;

// A reply to the query being worked on: a tapped button, a few words
// ("Items", "Waikanae"), or a change to it. Not a fresh question like "The
// circ PC has no internet" or "Customer wants to renew their books".
function refinesQuery(message: string, tappedButton: boolean): boolean {
  if (tappedButton || wordCount(message) <= 3) return true;
  if (wordCount(message) > 15 || NEW_QUESTION.test(message.trim())) return false;
  const words = lookupWords(message);
  return QUERY_CHANGE.test(message) || branchNames().some((branch) => words.includes(branch));
}

// The [[buttons]] in an answer, which come back as the staff member's reply when tapped.
function buttonsIn(answer: string): string[] {
  return [...answer.matchAll(/\[\[(.*?)\]\]/g)].map((m) => m[1].trim().toLowerCase());
}

export function detectRequest(message: string, history: ChatTurn[]): RequestKind {
  const lastAnswer = [...history].reverse().find((m) => m.role === 'model')?.content ?? '';
  const tappedButton = buttonsIn(lastAnswer).includes(message.trim().toLowerCase());

  // A short reply to one of the ink questions carries on the ink request.
  // Anything longer is treated as a new question.
  if ((INK_WORDS.test(message) && !INK_TROUBLE.test(message)) || (INK_QUESTIONS.test(lastAnswer) && wordCount(message) <= 4)) {
    return 'ink';
  }
  if (isBooleanRequest(message)) return 'boolean';
  // Replies while working out a Boolean query ("Items", "now only Waikanae")
  // stay in Boolean mode, even a few questions in.
  const recentQuestions = history.filter((m) => m.role === 'user').slice(-3);
  const recentAnswers = history.filter((m) => m.role === 'model').slice(-3);
  const workingOnQuery =
    recentQuestions.some((m) => isBooleanRequest(m.content)) || recentAnswers.some((m) => m.content.includes('```boolean'));
  if (workingOnQuery && refinesQuery(message, tappedButton)) {
    return 'boolean';
  }
  return 'general';
}

// ---------- Building the context for a question ----------

export function buildContext(
  message: string,
  history: ChatTurn[],
  guides: GuideIndex | null,
  vqdIndex: VQD[],
  lkpTables: LKPTable[],
): string {
  const kind = detectRequest(message, history);
  if (kind === 'ink') return printerInstruction();

  // Skips replies with nothing to search on, like "huh u sure".
  const previousQuestion =
    [...history].reverse().find((m) => m.role === 'user' && terms(m.content).length > 0)?.content ?? '';
  const parts: string[] = [];

  if (kind === 'boolean') {
    parts.push(booleanMandate());
    // A short reply like "Items" only makes sense with what was asked before it.
    const earlierQuestions = history.filter((m) => m.role === 'user').slice(-3).map((m) => m.content);
    const lookupText = wordCount(message) <= 15 ? [...earlierQuestions, message].join(' ') : message;

    const vqdMatches = searchVQDDescriptions(vqdIndex, lookupText, 40);
    if (vqdMatches.length > 0) {
      parts.push(
        `--- VQD MATCHES (Top Relevant Variables) ---\n` +
          vqdMatches
            .map(
              (vqd) => `ID: ${vqd.id}
Variable: ${vqd.variable_name}
Type: ${vqd.type}
Format: ${vqd.format ?? 'None'}
Record: ${vqd.record_type ?? 'None'}
Description: ${vqd.description}`,
            )
            .join('\n'),
      );
    }

    const lkpMatches = searchLKPDescriptions(lkpTables, lookupText, 15);
    if (lkpMatches.length > 0) {
      parts.push(
        `--- LKP MATCHES (Lookup Tables & Values) ---\n` +
          lkpMatches
            .map(
              (table) =>
                `Table ID: ${table.table_id}\nTable Description: ${table.table_description}\nRows:\n` +
                table.matchedRows.map((row) => `  - ID: ${row.id}\n    Description: ${row.description}`).join('\n'),
            )
            .join('\n'),
      );
    }

    if (guides) parts.push(formatExcerpts({ chunks: booleanExamples(guides, lookupText), partial: false }));
  } else if (guides) {
    let excerpts: Excerpts = searchGuides(guides, message, previousQuestion);
    // A short reply that doubts an answer, or matches no guide, is about an
    // earlier answer, so it gets the guides that answer came from. Searched on
    // its own words, "cap" finds unrelated guides, and the AI then decides its
    // earlier answer was made up.
    const doubting = doubtsAnswer(message);
    if (doubting || (wordCount(message) <= 8 && excerpts.chunks.length === 0)) {
      const earlier = earlierExcerpts(guides, history);
      if (earlier) excerpts = { ...earlier, doubting };
    }
    parts.push(formatExcerpts(excerpts));
  }
  // Last, where the weaker free models are most likely to follow them.
  parts.push(REPLY_RULES);
  return parts.join('\n\n');
}

// "u sure?", "cap", "prove it", "isn't what you told me correct?"
const DOUBT = /\b(sure|cap|really|huh|prove|proof|source|wrong|incorrect|correct|right|true|lie|lying|liar|bs|made (it|that|this) up)\b/i;

function doubtsAnswer(message: string): boolean {
  return wordCount(message) <= 8 && DOUBT.test(message);
}

// The excerpts for the latest earlier question that matched a guide, skipping
// replies like "cap" or "huh?".
function earlierExcerpts(guides: GuideIndex, history: ChatTurn[]): Excerpts | null {
  const questions = history.filter((m) => m.role === 'user').slice(-6).reverse();
  for (const { content } of questions) {
    if (doubtsAnswer(content)) continue;
    const found = searchGuides(guides, content);
    if (found.chunks.length > 0) return { ...found, earlierQuestion: content };
  }
  return null;
}

const BOOLEAN_GUIDE = /Boolean Queries\.html$/i;

// The "Boolean queries" guide is a set of worked example queries. Its opening
// section (where to run them, the format) always goes in, with the examples
// closest to the request. Other guides are left out: pages like "Creating
// canned searches" use a URL syntax that looks similar but doesn't work here.
function booleanExamples(index: GuideIndex, request: string): GuideChunk[] {
  const sections = index.chunks.filter((c) => BOOLEAN_GUIDE.test(c.path));
  if (sections.length === 0) return [];
  const intro = sections.find((c) => c.position === 0) ?? sections[0];
  const ranked = rankGuides(index, request)
    .filter(({ chunk }) => BOOLEAN_GUIDE.test(chunk.path) && chunk !== intro)
    .map(({ chunk }) => chunk);
  const examples = (ranked.length > 0 ? ranked : sections.filter((c) => c !== intro)).slice(0, 3);
  return [intro, ...examples]
    .sort((x, y) => x.position - y.position)
    .map(({ guide, source, version, heading, text, path }) => ({ guide, source, version, heading, text, path }));
}

// ---------- Spydus variables (vqd.json) and lookup tables (lkp.json) ----------

export function parseVQD(text: string): VQD[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error('vqd.json must contain a JSON array');
  return raw
    .filter((item) => item && typeof item === 'object' && typeof item.variable_name === 'string')
    .map((item) => ({
      id: Number(item.id),
      variable_name: item.variable_name,
      type: item.type ?? '',
      format: item.format ?? null,
      record_type: item.record_type ?? null,
      description: item.description ?? '',
      search_text: item.search_text ?? '',
    }));
}

export function parseLKP(text: string): LKPTable[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error('lkp.json must contain a JSON array of tables');
  return raw
    .filter((table) => table && typeof table === 'object' && Array.isArray(table.rows))
    .map((table) => ({
      table_id: table.table_id,
      table_description: table.table_description,
      rows: table.rows
        .filter((row: any) => row && typeof row.id === 'string' && typeof row.description === 'string')
        .map((row: any): LKP => ({ id: row.id, description: row.description })),
    }));
}

function baseForm(word: string): string {
  word = word.toLowerCase();
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('s') && word.length > 3) return word.slice(0, -1);
  if (word.endsWith('ed') && word.length > 3) return word.slice(0, -2);
  if (word.endsWith('ing') && word.length > 4) return word.slice(0, -3);
  return word;
}

function matchesWord(inputWord: string, descriptionWord: string): boolean {
  const inputForms = [inputWord, inputWord.endsWith('s') ? inputWord.slice(0, -1) : inputWord].map(baseForm);
  const descForms = [descriptionWord, descriptionWord.endsWith('s') ? descriptionWord.slice(0, -1) : descriptionWord].map(baseForm);
  // Short words like "due" must match whole words, or they'd match inside "residue".
  return inputForms.some((i) => descForms.some((d) => (i.length <= 3 ? d === i : i.length <= d.length && d.includes(i))));
}

function lookupWords(text: string): string[] {
  return withoutMacrons(text.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

// Words that say what a query is for but don't pick out a variable or code.
const QUERY_FILLER = new Set([
  'boolean', 'query', 'queries', 'search', 'write', 'find', 'list', 'show', 'spydus', 'records', 'record',
  'more', 'less', 'least', 'over', 'under', 'within', 'last', 'next', 'every', 'days', 'weeks', 'months', 'years',
]);

// Staff words for things the variable descriptions name differently.
const QUERY_SYNONYMS: [RegExp, string[]][] = [
  [/\boverdue\b/i, ['due', 'loan']],
  [/\b(on loan|borrowed|checked out|issued)\b/i, ['loan']],
  [/\bholds?\b/i, ['reservation']],
  // "Missing items" means the item status code (ITMSCDE). Statuses that need a
  // loan, like Claims Returned, are loan status codes (LOANSCDE).
  [/\b(missing|damaged|withdrawn|written off|on order|in transit)\b/i, ['status', 'item']],
  [/\b(lost|claim(s|ed)? (returned|never borrowed)|never borrowed)\b/i, ['status', 'loan']],
  [/\b(owe|owes|owing|debt|outstanding|fines?|fees?)\b/i, ['charge']],
];

type LKPSearchResult = { table_id: string; table_description: string; matchedRows: LKP[] };

const MAX_LKP_ROWS = 30;

// Rarer words count for more, so a table holding "Paraparaumu" ranks above
// the many that just mention "items".
function rarity(matches: number, total: number): number {
  return Math.log(1 + total / Math.max(matches, 1));
}

export function searchLKPDescriptions(tables: LKPTable[], inputText: string, topN: number): LKPSearchResult[] {
  const inputWords = [...new Set(lookupWords(inputText).filter((w) => !QUERY_FILLER.has(w)))];
  if (inputWords.length === 0) return [];

  const matched = tables.map((table) => {
    const rowsByWord = new Map<string, LKP[]>();
    for (const word of inputWords) {
      const rows = table.rows.filter((row) => lookupWords(`${row.description} ${row.id}`).some((w) => matchesWord(word, w)));
      if (rows.length > 0) rowsByWord.set(word, rows);
    }
    const describes = new Set(
      inputWords.filter((word) => lookupWords(table.table_description ?? '').some((w) => matchesWord(word, w))),
    );
    return { table, rowsByWord, describes };
  });

  // Counted across rows: "Waikanae" is in a few dozen rows, "borrowers" in hundreds.
  const totalRows = tables.reduce((sum, t) => sum + t.rows.length, 0);
  const rowsPerWord = new Map(
    inputWords.map((w) => [w, matched.reduce((sum, m) => sum + (m.rowsByWord.get(w)?.length ?? 0), 0)]),
  );

  const scored = matched
    .filter((m) => m.rowsByWord.size > 0)
    .map((m) => {
      let score = 0;
      for (const word of m.rowsByWord.keys()) score += rarity(rowsPerWord.get(word)!, totalRows);
      for (const word of m.describes) score += 0.5 * rarity(rowsPerWord.get(word) || 1, totalRows);
      const rows = [...new Set([...m.rowsByWord.values()].flat())];
      return { m, score, result: { table_id: m.table.table_id, table_description: m.table.table_description, matchedRows: rows.slice(0, MAX_LKP_ROWS) } };
    })
    .sort((a, b) => b.score - a.score);

  // Each word gets its own best tables first, so a branch name's location
  // tables aren't crowded out by tables matching several common words.
  const picked = new Map<string, LKPSearchResult>();
  const byRarity = [...inputWords].sort((a, b) => rowsPerWord.get(a)! - rowsPerWord.get(b)!);
  const branches = branchNames();
  const libraryNames = libraryWords();
  for (const word of byRarity) {
    const isBranch = branches.includes(word);
    const isInstitution = libraryNames.includes(word);
    const candidates = scored
      .filter((t) => t.m.rowsByWord.has(word))
      .sort((a, b) => {
        // For a branch name, the location tables come first. For the library's
        // own name ("Kāpiti") the Institutions table does, since the database is
        // shared with other libraries; otherwise tables like collections and
        // widgets that mention the library push it out.
        const fit = (t: typeof a) => {
          const description = t.m.table.table_description ?? '';
          return (isBranch && /location|branch/i.test(description)) || (isInstitution && /institution/i.test(description)) ? 1 : 0;
        };
        return fit(b) - fit(a) || b.score - a.score;
      });
    for (const t of candidates.slice(0, 3)) picked.set(t.result.table_id, t.result);
  }
  for (const t of scored) {
    if (picked.size >= topN) break;
    picked.set(t.result.table_id, t.result);
  }
  return [...picked.values()].slice(0, Math.max(topN, picked.size));
}

// From the person's library settings, as lookup words: 'otaki', 'kapiti'.
const branchNames = () => librarySettings().branches.flatMap((branch) => lookupWords(branch.name));
const libraryWords = () => lookupWords(librarySettings().shortName);

const BORROWER_WORDS = ['borrower', 'borrowers', 'borrowed', 'brw'];

export function searchVQDDescriptions(index: VQD[], inputText: string, topN: number): VQD[] {
  const lower = withoutMacrons(inputText.toLowerCase());
  const words = new Set(lookupWords(lower).filter((w) => !QUERY_FILLER.has(w)));
  const institutionWords = [...libraryWords(), 'institution', 'home'];
  const locationWords = [...branchNames(), 'branch', 'location'];
  if (BORROWER_WORDS.some((w) => lower.includes(w))) words.add('borrower');
  if (institutionWords.some((w) => lower.includes(w))) institutionWords.forEach((w) => words.add(w));
  // Branch names never appear in variable descriptions; "location" does.
  if (locationWords.some((w) => lower.includes(w))) words.add('location');
  for (const [pattern, extra] of QUERY_SYNONYMS) if (pattern.test(lower)) extra.forEach((w) => words.add(w));
  if (words.size === 0) return [];

  const described = index.map((vqd) => ({ vqd, descWords: lookupWords(vqd.description) }));
  const variablesPerWord = new Map(
    [...words].map((w) => [w, described.filter((d) => d.descWords.some((dw) => matchesWord(w, dw))).length]),
  );

  const scored = described
    .map(({ vqd, descWords }) => {
      const hits = [...words].filter((word) => descWords.some((d) => matchesWord(word, d)));
      const score = hits.reduce((sum, word) => sum + rarity(variablesPerWord.get(word)!, index.length), 0);
      return { vqd, hits, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  // Each word gets its own best variables first, as with the lookup tables.
  const picked = new Map<number, VQD>();
  for (const word of words) {
    for (const item of scored.filter((i) => i.hits.includes(word)).slice(0, 6)) picked.set(item.vqd.id, item.vqd);
  }
  for (const item of scored) {
    if (picked.size >= topN) break;
    picked.set(item.vqd.id, item.vqd);
  }
  return [...picked.values()];
}
