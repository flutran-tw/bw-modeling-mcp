import { XMLParser } from 'fast-xml-parser';
import { BwClient, bwSeg } from '../bw-client.js';
import { queryAccept } from './query.js';

type Node = Record<string, unknown>;
const list = (v: unknown): Node[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]) as Node[];

/**
 * The master data a BW Query reads, as JSON: which characteristics are shown with their
 * texts, and which navigation attributes it uses. Both are only visible in the query XML,
 * not in bw_get_query.
 *
 *   texts                 characteristics in rows, columns or free characteristics whose values
 *                         show a text. Without an explicit setting the InfoObject default
 *                         applies and counts as text; Key and noDisplay do not.
 *   navigationAttributes  "CHAR__ATTR" characteristics anywhere in the query (layout, filter,
 *                         selections, variables), as { infoObject: CHAR, attribute: ATTR }.
 */
export async function readQueryMasterDataUsage(client: BwClient, query: string): Promise<string> {
  const base = `/sap/bw/modeling/query/${bwSeg(query)}`;
  let body: string;
  try {
    body = (await client.get(`${base}/a`, queryAccept())).body;
  } catch (err) {
    if (!String((err as Error).message).includes('HTTP 404')) throw err;
    body = (await client.get(`${base}/m`, queryAccept())).body;
  }
  const main = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    isArray: (tag) => ['Qry:free', 'Qry:rows', 'Qry:columns'].includes(tag),
  }).parse(body)['Qry:queryResource']?.['Qry:mainComponent'] as Node | undefined ?? {};

  const texts = new Set<string>();
  for (const axis of ['Qry:rows', 'Qry:columns', 'Qry:free']) {
    for (const dim of list(main[axis])) {
      const name = dim['@_infoObjectName'] as string | undefined;
      if (dim['@_xsi:type'] !== 'Qry:Dimension' || !name || name.includes('__')) continue;
      const kv = list((dim['Qry:additionalInfo'] as Node | undefined)?.['Qry:keyValuePairs']);
      if (kv.some((p) => p['@_key'] === 'infoObjectType' && p['@_value'] === 'KYF')) continue;
      const presentation = dim['Qry:valuePresentation'] as Node | undefined;
      const presentAs = presentation?.['@_presentAs'] as string | undefined;
      if (!presentation || presentation['@_default'] !== 'false' || !presentAs || /Text/.test(presentAs)) texts.add(name);
    }
  }

  const navigation = new Map<string, { infoObject: string; attribute: string }>();
  for (const m of body.matchAll(/\binfoObject(?:Name)?="([^"]+__[^"]+)"/g)) {
    const [infoObject, ...rest] = m[1].split('__');
    if (infoObject && rest.length) navigation.set(m[1], { infoObject, attribute: rest.join('__') });
  }
  return JSON.stringify({ query, texts: [...texts].sort(), navigationAttributes: [...navigation.values()] });
}
