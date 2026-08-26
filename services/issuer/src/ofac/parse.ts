/**
 * Parsing the OFAC XML lists.
 *
 * Both the SDN list and the Consolidated list use the same schema. Digital-currency addresses live
 * in `<id>` elements whose `<idType>` reads `Digital Currency Address - XXX`:
 *
 * ```xml
 * <sdnEntry>
 *   <uid>12345</uid>
 *   <lastName>SOME ENTITY</lastName>
 *   <programList><program>CYBER2</program></programList>
 *   <idList>
 *     <id><uid>196530</uid>
 *         <idType>Digital Currency Address - ETH</idType>
 *         <idNumber>0x252a8bd2319d8a555b872990601221b3a2053bce</idNumber></id>
 *   </idList>
 * </sdnEntry>
 * ```
 *
 * The SDN list is around 30 MB and about 19,000 entries, of which fewer than a hundred carry a
 * digital-currency address. Parsing the whole document into objects to find those is wasteful, so
 * this splits the text into `<sdnEntry>` fragments, keeps only the ones that mention a digital
 * currency address, and hands each of those to a real XML parser. The cheap scan narrows; the XML
 * parser does the actual reading, so nothing here depends on a regular expression understanding
 * XML.
 */

import { XMLParser } from "fast-xml-parser";

/** The `<idType>` prefix OFAC uses for on-chain addresses. */
export const DIGITAL_CURRENCY_PREFIX = "Digital Currency Address";

/** One listed address, with enough context to say who it belongs to. */
export interface ListedAddress {
  /** The address exactly as OFAC published it, case intact. */
  address: string;
  /** The asset OFAC filed it under: `XBT`, `ETH`, `TRX`, `USDT`, and so on. */
  asset: string;
  /** The listed party's name, as one line. */
  name: string;
  /** OFAC's uid for the listed party — the stable handle for looking the entry up. */
  entryUid: string;
  /** OFAC's uid for this particular identifier. */
  idUid: string;
  /** The sanctions programmes the party is listed under, e.g. `CYBER2`, `DPRK3`. */
  programs: string[];
  /** `Individual`, `Entity`, or `Vessel`. */
  type: string;
}

/** What one list file said. */
export interface ParsedList {
  /** OFAC's own publication date for the file, as printed in it. */
  publishDate: string | null;
  /** OFAC's own record count for the file. */
  recordCount: number | null;
  /** Every digital-currency address in the file. */
  addresses: ListedAddress[];
  /** How many `<sdnEntry>` elements the file contained. */
  entryCount: number;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "id" || name === "program",
});

/**
 * Extract every digital-currency address from one OFAC list.
 *
 * Throws when the document is not an OFAC list at all — an error page served with a 200, say —
 * rather than quietly reporting zero addresses, which would look exactly like a clean list.
 */
export function parseOfacList(xml: string): ParsedList {
  if (!xml.includes("<sdnList") && !xml.includes("<sdnEntry")) {
    throw new OfacParseError(
      "the document is not an OFAC sanctions list: no <sdnList> or <sdnEntry> element found",
    );
  }

  const addresses: ListedAddress[] = [];
  let entryCount = 0;

  for (const fragment of entryFragments(xml)) {
    entryCount += 1;
    if (!fragment.includes(DIGITAL_CURRENCY_PREFIX)) continue;
    addresses.push(...parseEntry(fragment));
  }

  return {
    publishDate: between(xml, "<Publish_Date>", "</Publish_Date>"),
    recordCount: toCount(between(xml, "<Record_Count>", "</Record_Count>")),
    addresses,
    entryCount,
  };
}

/** Thrown when a document cannot be read as an OFAC list. */
export class OfacParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfacParseError";
  }
}

function* entryFragments(xml: string): Generator<string> {
  const open = "<sdnEntry>";
  const close = "</sdnEntry>";
  let cursor = 0;
  for (;;) {
    const start = xml.indexOf(open, cursor);
    if (start === -1) return;
    const end = xml.indexOf(close, start);
    if (end === -1) return;
    yield xml.slice(start, end + close.length);
    cursor = end + close.length;
  }
}

interface RawId {
  uid?: string;
  idType?: string;
  idNumber?: string;
}

interface RawEntry {
  uid?: string;
  firstName?: string;
  lastName?: string;
  sdnType?: string;
  title?: string;
  programList?: { program?: string[] };
  idList?: { id?: RawId[] };
}

function parseEntry(fragment: string): ListedAddress[] {
  const parsed = parser.parse(fragment) as { sdnEntry?: RawEntry };
  const entry = parsed.sdnEntry;
  if (!entry) return [];

  const name = [entry.firstName, entry.lastName].filter(Boolean).join(" ").trim();
  const programs = entry.programList?.program ?? [];
  const ids = entry.idList?.id ?? [];

  const listed: ListedAddress[] = [];
  for (const id of ids) {
    const idType = id.idType ?? "";
    if (!idType.startsWith(DIGITAL_CURRENCY_PREFIX)) continue;
    const address = (id.idNumber ?? "").trim();
    if (address === "") continue;
    listed.push({
      address,
      asset: idType.slice(DIGITAL_CURRENCY_PREFIX.length).replace(/^\s*-\s*/, "").trim(),
      name: name === "" ? "(unnamed)" : name,
      entryUid: String(entry.uid ?? ""),
      idUid: String(id.uid ?? ""),
      programs: programs.map(String),
      type: entry.sdnType ?? "",
    });
  }
  return listed;
}

function between(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  const end = text.indexOf(close, start + open.length);
  if (end === -1) return null;
  const value = text.slice(start + open.length, end).trim();
  return value === "" ? null : value;
}

function toCount(value: string | null): number | null {
  if (value === null) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}
