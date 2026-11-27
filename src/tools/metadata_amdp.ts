import { BwClient, MEDIA_TYPES, bwSeg } from '../bw-client.js';

/**
 * Fork addition (kept in its own file so an upstream merge does not touch it; the only hook
 * is `case 'AMDP'` in metadata_tables.ts).
 *
 * The source of every routine of a transformation that lives in a generated ABAP class,
 * as JSON. On BW/4HANA that is the AMDP (SQLScript) routines: start, end, expert and field
 * routines are methods of the class `/BIC/…_M`, not rows of RSAABAP, so `TRFN` cannot show
 * them. The class and method names come from the transformation definition; the source is
 * read from ADT, active version first.
 *
 *   transformation  the transformation id
 *   version         "a" (active) or "m" (inactive) definition that was read
 *   routines        [{ kind, rule, class, method, language, found, code, targets }]
 *                   kind: start | end | expert | field; language: amdp | abap
 *   classes         [{ name, found, lines }] — one entry per generated class read
 *   unmatched       classes whose source could not be read or lacks the method (404, no METHOD)
 */

export interface AmdpRoutine {
  kind: 'start' | 'end' | 'expert' | 'field';
  rule: string;
  class: string;
  method: string;
  language: 'amdp' | 'abap' | null;
  found: boolean;
  code: string;
  targets: string[];
}

const AMDP_MARKER = /\bBY\s+DATABASE\s+PROCEDURE\b|\bLANGUAGE\s+SQLSCRIPT\b/i;

const decode = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const kindOf = (routinetype: string): AmdpRoutine['kind'] => {
  const t = routinetype.toUpperCase();
  return t === 'START' ? 'start' : t === 'END' ? 'end' : t === 'EXPERT' ? 'expert' : 'field';
};

/** The `METHOD <name> … ENDMETHOD.` block of a class source, or null. */
export function extractMethod(source: string, method: string): string | null {
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = new RegExp(`^[ \\t]*METHOD\\s+${escaped}\\b[^\\n]*$`, 'im').exec(source);
  if (!start) return null;
  const rest = source.slice(start.index);
  const end = /^[ \t]*ENDMETHOD\s*\./im.exec(rest);
  if (!end) return rest;
  return rest.slice(0, end.index + end[0].length);
}

/** Class and method of every routine step in the transformation XML, one entry per rule. */
export function routineSteps(xml: string): Pick<AmdpRoutine, 'kind' | 'rule' | 'class' | 'method' | 'targets'>[] {
  const out: ReturnType<typeof routineSteps> = [];
  for (const rm of xml.matchAll(/<rule\b([^>]*)>([\s\S]*?)<\/rule>/g)) {
    const step = rm[2].match(/<step\b([^>]*)/)?.[1] ?? '';
    const cls = step.match(/classNameM="([^"]*)"/)?.[1];
    const method = step.match(/methodNameM="([^"]*)"/)?.[1];
    if (!cls || !method) continue;
    out.push({
      kind: kindOf(rm[1].match(/routinetype="([^"]*)"/)?.[1] ?? ''),
      rule: rm[1].match(/\bid="([^"]*)"/)?.[1] ?? '',
      class: decode(cls),
      method: decode(method),
      targets: [...rm[2].matchAll(/elementRef>#\/\/\/target\/[^/]+\/([^<]+)<\/elementRef>/g)].map((m) => m[1]),
    });
  }
  return out;
}

async function readClassSource(client: BwClient, cls: string): Promise<string | null> {
  const seg = encodeURIComponent(cls).toLowerCase();
  for (const version of ['active', 'inactive']) {
    try {
      const { body } = await client.get(`/sap/bc/adt/oo/classes/${seg}/source/main?version=${version}`, 'text/plain');
      if (body.trim()) return body;
    } catch (err) {
      if (!String((err as Error).message).includes('HTTP 404')) throw err;
    }
  }
  return null;
}

export async function readAmdpSource(client: BwClient, tranId: string): Promise<string> {
  const base = `/sap/bw/modeling/trfn/${bwSeg(tranId.toLowerCase())}`;
  let xml: string;
  let version = 'a';
  try {
    xml = (await client.get(`${base}/a`, MEDIA_TYPES.trfn)).body;
  } catch (err) {
    if (!String((err as Error).message).includes('HTTP 404')) throw err;
    version = 'm';
    xml = (await client.get(`${base}/m`, MEDIA_TYPES.trfn)).body;
  }

  const steps = routineSteps(xml);
  const sources = new Map<string, string | null>();
  for (const cls of new Set(steps.map((s) => s.class))) sources.set(cls, await readClassSource(client, cls));

  const routines: AmdpRoutine[] = steps.map((s) => {
    const source = sources.get(s.class) ?? null;
    const code = source ? extractMethod(source, s.method) : null;
    return {
      ...s,
      language: code ? (AMDP_MARKER.test(code) ? 'amdp' : 'abap') : null,
      found: code !== null,
      code: code ?? '',
    };
  });

  return JSON.stringify({
    transformation: tranId.toUpperCase(),
    version,
    routines,
    classes: [...sources].map(([name, src]) => ({ name, found: src !== null, lines: src ? src.split('\n').length : 0 })),
    unmatched: routines.filter((r) => !r.found).map((r) => `${r.class}.${r.method}`),
  });
}
