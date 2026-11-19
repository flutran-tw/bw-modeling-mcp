import { BwClient } from '../bw-client.js';
import { queryTable, sqlLiteral, inListBatches, formatStamp, type Row } from './metadata_sql.js';

/**
 * Read the 3.x data flow — update rules, transfer rules, 3.x DataSources and 3.x InfoSources —
 * from their metadata tables.
 *
 * These objects predate the BW Modeling Tools. SAP never gave them an ADT or REST resource on
 * any release, and the BW search index does not contain them, so the tables are the only
 * route. They exist on classic SAP BW only; BW/4HANA removed the 3.x data flow.
 *
 * Every object type here is versioned (OBJVERS): A is what runs, M a change not activated
 * yet, D the Business Content delivery copy that was never installed. A system that took
 * content over years carries hundreds of D rows and no A row at all, so every listing states
 * the version of each object — counting the rows would overstate the 3.x data flow badly.
 *
 * Table layouts verified on a 7.5 system (DD03L): RSUPDINFO, RSUPDDAT, RSUPDKEY, RSUPDROUT,
 * RSTS, RSTSRULES, RSISOSMAP, RSIS, RSIST, RSKSFIELD, RSOLTPSOURCE, RSOLTPSOURCET, RSAABAP.
 * Transfer rules (RSTS/RSTSRULES) had no rows on that system, so their reader is built from
 * the dictionary alone.
 *
 * The DataPreview service parses at most 255 characters of statement, so every statement
 * stays short and IN-lists go through inListBatches.
 */

const VERSION_ORDER = ['A', 'M', 'D'] as const;
const VERSION_LABEL: Record<string, string> = {
  A: 'active',
  M: 'modified (not activated)',
  D: 'delivered content (not installed)',
};

const rank = (v: string): number => {
  const i = (VERSION_ORDER as readonly string[]).indexOf(v);
  return i < 0 ? VERSION_ORDER.length : i;
};

/**
 * One row per key, the most relevant version kept: active, then modified, then delivered.
 * VERSIONS carries every version found for the key, comma-separated.
 */
function headsBy(rows: Row[], key: (r: Row) => string): Map<string, Row> {
  const heads = new Map<string, Row>();
  for (const r of rows) {
    const k = key(r);
    const held = heads.get(k);
    if (!held) {
      heads.set(k, { ...r, VERSIONS: r.OBJVERS });
    } else {
      const versions = `${held.VERSIONS},${r.OBJVERS}`;
      if (rank(r.OBJVERS) < rank(held.OBJVERS)) heads.set(k, { ...r, VERSIONS: versions });
      else held.VERSIONS = versions;
    }
  }
  return heads;
}

function versionCounts(heads: Iterable<Row>): string {
  const counts = new Map<string, number>();
  for (const h of heads) counts.set(h.OBJVERS, (counts.get(h.OBJVERS) ?? 0) + 1);
  return VERSION_ORDER.map((v) => `${VERSION_LABEL[v].split(' ')[0]} ${counts.get(v) ?? 0}`).join(', ');
}

const toLike = (pattern: string): string => sqlLiteral(pattern.trim().toUpperCase()).replace(/\*/g, '%');

function hasStatements(code: string): boolean {
  return code
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l && !l.startsWith('*') && !l.startsWith('"') && !/insert your code here/i.test(l));
}

function indent(code: string): string {
  return code
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
}

/** Source lines per code id, all in one version. RSAABAP keys routine code of every flow type. */
async function readCode(client: BwClient, codeIds: string[], version: string): Promise<Map<string, string>> {
  const lines = new Map<string, Row[]>();
  const ids = [...new Set(codeIds.filter((c) => c && !/^0*$/.test(c)))];
  for (const batch of inListBatches(ids, 150)) {
    const rows = await queryTable(
      client,
      `SELECT codeid, line_no, line FROM rsaabap WHERE objvers = '${sqlLiteral(version)}' AND codeid IN (${batch})`,
      20000,
    );
    for (const r of rows) lines.set(r.CODEID, [...(lines.get(r.CODEID) ?? []), r]);
  }
  const code = new Map<string, string>();
  for (const [id, rows] of lines) {
    code.set(
      id,
      rows
        .sort((a, b) => Number(a.LINE_NO) - Number(b.LINE_NO))
        .map((r) => r.LINE)
        .join('\n'),
    );
  }
  return code;
}

/** Texts of one text table, English first, keyed by the object name column. */
async function readTexts(
  client: BwClient,
  table: string,
  keyColumn: string,
  names: string[],
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const batch of inListBatches(names, 150)) {
    try {
      const rows = await queryTable(
        client,
        `SELECT ${keyColumn}, langu, txtlg FROM ${table} WHERE objvers = 'A' AND ${keyColumn} IN (${batch})`,
        2000,
      );
      const key = keyColumn.toUpperCase();
      for (const r of rows) {
        if (r.TXTLG && (r.LANGU === 'E' || !texts.has(r[key]))) texts.set(r[key], r.TXTLG.trim());
      }
    } catch {
      // A description is an enrichment; the name identifies the object.
    }
  }
  return texts;
}

const versionLine = (head: Row): string[] => {
  const out = [`Version:      ${head.OBJVERS} — ${VERSION_LABEL[head.OBJVERS] ?? 'unknown version'}`];
  const others = (head.VERSIONS ?? '').split(',').filter((v) => v && v !== head.OBJVERS);
  if (others.length) out.push(`              (also present as ${others.join(', ')})`);
  return out;
};

const inactiveNote = (head: Row): string[] =>
  head.OBJVERS === 'A'
    ? []
    : [
        '',
        `NOTE: no active version. This ${head.OBJVERS === 'D' ? 'is Business Content that was never installed' : 'change was never activated'};`,
        'nothing in this definition runs on the system.',
      ];

// ── Update rules (UPDR) ─────────────────────────────────────────────────────

/** RSUPDDAT-UPDTYPE, domain RSUPDTYPE. */
const UPDATE_TYPES: Record<string, string> = { MOV: 'overwrite', ADD: 'addition', NOP: 'no update', MIN: 'minimum', MAX: 'maximum' };

/** RSUPDDAT-CALCTPDAT (key figure) and RSUPDKEY-CALCTPKEY (characteristic), domains RSCALCTPDAT/KEY. */
const CALC_TYPES: Record<string, string> = {
  '0': 'no calculation',
  '1': 'source InfoObject',
  '2': 'formula',
  '3': 'routine',
  '4': 'constant',
  '5': 'master data read',
  '6': 'time split',
};

/** RSUPDROUT-ROUTINE numbers with a fixed meaning; every other number is a rule routine. */
const START_ROUTINE = '9998';
const GLOBAL_PART = '9999';

function describeRule(r: Row, calc: string, routineLabel: (no: string) => string): string {
  switch (calc) {
    case '1':
      return r.CSIOBJNM || '(source not set)';
    case '2':
      return `formula ${r.FORMULA_ID || r.FRMLAID || ''}`.trim();
    case '3':
      return routineLabel(r.ROUTINE);
    case '4':
      return `constant '${r.CONSTANT ?? ''}'`;
    case '5':
      return `master data of ${r.CSIOBJNM || '?'}${r.CMIOBJNM ? ` (attribute ${r.CMIOBJNM})` : ''}`;
    case '6':
      return `time split${r.CSPLITIOBJNM ? ` by ${r.CSPLITIOBJNM}` : ''}`;
    case '0':
    case '':
      return '(not filled)';
    default:
      return `calculation type ${calc}`;
  }
}

async function listUpdateRules(client: BwClient, pattern: string, byTarget: boolean): Promise<string> {
  const where = byTarget
    ? `infocube = '${sqlLiteral(pattern.trim().toUpperCase())}'`
    : `infocube LIKE '${toLike(pattern)}'`;
  const rows = await queryTable(
    client,
    `SELECT updid, objvers, infocube, isource, startroutine, expertmode, tstpnm, timestmp FROM rsupdinfo WHERE ${where}`,
    5000,
  );
  const heads = headsBy(rows, (r) => r.UPDID);
  if (heads.size === 0) {
    return byTarget
      ? `No update rules load ${pattern.toUpperCase()} (RSUPDINFO).`
      : `No update rules match ${pattern} (RSUPDINFO, pattern on the target provider). Update rules ` +
          `exist on classic SAP BW only.`;
  }

  // Routines per update rule and version, without the global part every update rule carries.
  const routines = new Map<string, number>();
  for (const batch of inListBatches([...heads.keys()], 150)) {
    const r = await queryTable(
      client,
      `SELECT updid, objvers, routine FROM rsupdrout WHERE routine <> '${GLOBAL_PART}' AND updid IN (${batch})`,
      5000,
    );
    for (const x of r) routines.set(`${x.UPDID}/${x.OBJVERS}`, (routines.get(`${x.UPDID}/${x.OBJVERS}`) ?? 0) + 1);
  }

  const out = [
    `Update rules (3.x) ${byTarget ? `loading ${pattern.toUpperCase()}` : `matching ${pattern.toUpperCase()}`}: ` +
      `${heads.size} (${versionCounts(heads.values())})`,
    '',
  ];
  const sorted = [...heads.values()].sort(
    (a, b) => rank(a.OBJVERS) - rank(b.OBJVERS) || a.INFOCUBE.localeCompare(b.INFOCUBE) || a.ISOURCE.localeCompare(b.ISOURCE),
  );
  for (const h of sorted) {
    const n = routines.get(`${h.UPDID}/${h.OBJVERS}`) ?? 0;
    const bits = [
      VERSION_LABEL[h.OBJVERS] ?? h.OBJVERS,
      `routines ${n}`,
      h.STARTROUTINE && !/^0*$/.test(h.STARTROUTINE) ? 'start routine' : '',
      h.EXPERTMODE === 'X' ? 'expert mode' : '',
      `changed ${formatStamp(h.TIMESTMP) || '?'} by ${h.TSTPNM || '(unknown)'}`,
    ].filter(Boolean);
    out.push(`  ${h.UPDID}  ${h.INFOCUBE} <- ${h.ISOURCE}  [${bits.join(', ')}]`);
  }
  out.push('', 'Read one with object_type="UPDR" and its id (the first column).');
  return out.join('\n');
}

export async function readUpdateRules(client: BwClient, name: string): Promise<string> {
  if (name.includes('*')) return listUpdateRules(client, name, false);
  const id = sqlLiteral(name.trim().toUpperCase());

  const versions = await queryTable(
    client,
    `SELECT updid, objvers, infocube, isource, startroutine, expertmode, objstat, tstpnm, timestmp, urprogid ` +
      `FROM rsupdinfo WHERE updid = '${id}'`,
    10,
  );
  // Not an update rule id: a provider name lists the update rules that load it.
  if (versions.length === 0) return listUpdateRules(client, name, true);

  const head = [...headsBy(versions, (r) => r.UPDID).values()][0];
  const v = sqlLiteral(head.OBJVERS);
  const scope = `updid = '${id}' AND objvers = '${v}'`;
  const keyFigureRules = await queryTable(
    client,
    `SELECT ruleno, updtype, calctpdat, iciobjnm, csiobjnm, routine, constant, unitconv, frmlaid FROM rsupddat WHERE ${scope}`,
    2000,
  );
  const charRules = await queryTable(
    client,
    `SELECT ruleno, posit, iciobjnm, csiobjnm, routine, calctpkey, constant, cmiobjnm, formula_id, csplitiobjnm ` +
      `FROM rsupdkey WHERE ${scope}`,
    20000,
  );
  const routines = await queryTable(client, `SELECT routine, iciobjnm, codeid FROM rsupdrout WHERE ${scope}`, 2000);
  const code = await readCode(client, routines.map((r) => r.CODEID), head.OBJVERS);
  const isText = (await readTexts(client, 'rsist', 'isource', [head.ISOURCE])).get(head.ISOURCE);

  const routineNo = (no: string) => (no || '').padStart(4, '0');
  const routineLabel = (no: string) => `routine ${routineNo(no)}`;
  const start = head.STARTROUTINE && !/^0*$/.test(head.STARTROUTINE) ? routineNo(head.STARTROUTINE) : '';

  const out: string[] = [];
  out.push(`Update Rules: ${head.UPDID}`);
  out.push('Source: metadata tables (3.x data flow — no release publishes a REST resource for it)');
  out.push(`Target:       ${head.INFOCUBE}`);
  out.push(`InfoSource:   ${head.ISOURCE}${isText ? ` — ${isText}` : ''}`);
  out.push(...versionLine(head));
  out.push(`Expert mode:  ${head.EXPERTMODE === 'X' ? 'yes' : 'no'}`);
  out.push(`Program:      ${head.URPROGID || '(not generated)'}`);
  out.push(`Last changed: ${formatStamp(head.TIMESTMP) || '?'} by ${head.TSTPNM || '(unknown)'}`);
  out.push(...inactiveNote(head));

  // ── Rules ──
  // Key figure rules (RSUPDDAT) each own a set of characteristic rules (RSUPDKEY, same RULENO).
  // Most update rules use one set for every key figure, so identical sets are printed once.
  const charsByRule = new Map<string, Row[]>();
  for (const c of charRules) charsByRule.set(c.RULENO, [...(charsByRule.get(c.RULENO) ?? []), c]);
  const signature = (rows: Row[]) =>
    rows
      .sort((a, b) => Number(a.POSIT) - Number(b.POSIT))
      .map((c) => `${c.ICIOBJNM}=${c.CALCTPKEY}:${describeRule(c, c.CALCTPKEY, routineLabel)}`)
      .join('|');
  const sets = new Map<string, { rows: Row[]; rules: string[] }>();
  for (const [ruleNo, rows] of charsByRule) {
    const sig = signature(rows);
    const set = sets.get(sig) ?? { rows, rules: [] };
    set.rules.push(ruleNo);
    sets.set(sig, set);
  }
  const setOfRule = new Map<string, number>();
  [...sets.values()].forEach((s, i) => s.rules.forEach((r) => setOfRule.set(r, i + 1)));

  out.push('');
  out.push(`── Key Figure Rules (${keyFigureRules.length}) ──`);
  if (keyFigureRules.length === 0) out.push('  (none — a target without key figures, such as master data or a DSO of characteristics)');
  for (const r of keyFigureRules.sort((a, b) => Number(a.RULENO) - Number(b.RULENO))) {
    const bits = [
      UPDATE_TYPES[r.UPDTYPE] ?? r.UPDTYPE,
      CALC_TYPES[r.CALCTPDAT] ?? `calculation type ${r.CALCTPDAT}`,
      r.UNITCONV === 'X' ? 'unit conversion' : '',
      setOfRule.has(r.RULENO) ? `characteristics: set ${setOfRule.get(r.RULENO)}` : '',
    ].filter(Boolean);
    out.push(`  [${(CALC_TYPES[r.CALCTPDAT] ?? 'OTHER').toUpperCase().replace(/ /g, '_')}] ${r.ICIOBJNM} <- ${describeRule(r, r.CALCTPDAT, routineLabel)}   (${bits.join(', ')})`);
  }

  out.push('');
  out.push(`── Characteristic Rules (${sets.size} set${sets.size === 1 ? '' : 's'}) ──`);
  if (sets.size === 0) out.push('  (none)');
  [...sets.values()].forEach((s, i) => {
    out.push(`  set ${i + 1} — used by rule${s.rules.length === 1 ? '' : 's'} ${s.rules.map(routineNo).join(', ')}:`);
    for (const c of s.rows) {
      const calc = CALC_TYPES[c.CALCTPKEY] ?? `calculation type ${c.CALCTPKEY}`;
      out.push(`    [${calc.toUpperCase().replace(/ /g, '_')}] ${c.ICIOBJNM} <- ${describeRule(c, c.CALCTPKEY, routineLabel)}`);
    }
  });

  // ── Routines ──
  // Same labels as the transformation reader (globalPart, startRoutine, then one entry per
  // routine), so a client that parses one parses the other.
  out.push('');
  out.push('── Routines ──');
  const byNo = new Map(routines.map((r) => [routineNo(r.ROUTINE), r]));
  const fixed: [string, string][] = [
    ['globalPart', GLOBAL_PART],
    ['startRoutine', start || START_ROUTINE],
  ];
  for (const [label, no] of fixed) {
    const r = byNo.get(no);
    const src = r ? code.get(r.CODEID) ?? '' : '';
    if (!r || !hasStatements(src) || (label === 'startRoutine' && !start)) {
      out.push(`  ${label}: (none)`);
      continue;
    }
    out.push(`  ${label}: (code id ${r.CODEID})`);
    out.push(indent(src));
  }
  for (const r of routines.sort((a, b) => Number(a.ROUTINE) - Number(b.ROUTINE))) {
    const no = routineNo(r.ROUTINE);
    if (no === GLOBAL_PART || no === START_ROUTINE || no === start) continue;
    const src = code.get(r.CODEID);
    if (!src?.trim()) continue;
    out.push(`  routine ${no} (${r.ICIOBJNM || 'no InfoObject'}, code id ${r.CODEID}):`);
    out.push(indent(src));
  }
  out.push('');
  out.push('In the routine code, &CS& is the communication structure (the InfoSource record),');
  out.push('&RS& the result and &RA&/&RN& the record counters — placeholders BW replaces when it');
  out.push(`generates the program${head.URPROGID ? ` (${head.URPROGID})` : ''}.`);
  return out.join('\n');
}

// ── Transfer rules (ISTS) ───────────────────────────────────────────────────

/** RSISOSMAP-ISTYPE: what the InfoSource receives from the DataSource. */
const REQUEST_TYPES: Record<string, string> = { D: 'transaction data', M: 'master data attributes', T: 'texts', H: 'hierarchies' };

async function listTransferRules(client: BwClient, where: string, label: string): Promise<string> {
  const maps = await queryTable(
    client,
    `SELECT oltpsource, logsys, objvers, isource, transtru, istype FROM rsisosmap WHERE ${where}`,
    5000,
  );
  const heads = headsBy(maps, (r) => `${r.OLTPSOURCE}/${r.LOGSYS}`);
  if (heads.size === 0) return `No DataSource is assigned to a 3.x InfoSource ${label} (RSISOSMAP).`;

  // The transfer rules proper: a mapping without a transfer structure has none.
  const withRules = new Set<string>();
  const structures = [...new Set([...heads.values()].map((h) => h.TRANSTRU).filter(Boolean))];
  for (const batch of inListBatches(structures, 150)) {
    const r = await queryTable(client, `SELECT transtru, objvers FROM rsts WHERE transtru IN (${batch})`, 5000);
    for (const x of r) withRules.add(`${x.TRANSTRU}/${x.OBJVERS}`);
  }

  const out = [`Transfer rules / DataSource assignments (3.x) ${label}: ${heads.size} (${versionCounts(heads.values())})`, ''];
  const sorted = [...heads.values()].sort((a, b) => rank(a.OBJVERS) - rank(b.OBJVERS) || a.OLTPSOURCE.localeCompare(b.OLTPSOURCE));
  for (const h of sorted) {
    const rules = h.TRANSTRU && withRules.has(`${h.TRANSTRU}/${h.OBJVERS}`);
    const bits = [
      VERSION_LABEL[h.OBJVERS] ?? h.OBJVERS,
      REQUEST_TYPES[h.ISTYPE] ?? '',
      rules ? `transfer structure ${h.TRANSTRU}` : 'no transfer rules',
    ].filter(Boolean);
    out.push(`  ${h.OLTPSOURCE}  ${h.LOGSYS} -> ${h.ISOURCE}  [${bits.join(', ')}]`);
  }
  out.push('', 'Read one with object_type="ISTS" and the transfer structure or the DataSource name.');
  return out.join('\n');
}

export async function readTransferRules(client: BwClient, name: string): Promise<string> {
  if (name.includes('*')) return listTransferRules(client, `oltpsource LIKE '${toLike(name)}'`, `matching ${name.toUpperCase()}`);
  const n = sqlLiteral(name.trim().toUpperCase());

  let versions = await queryTable(
    client,
    `SELECT transtru, objvers, logsys, startroutine, glbcode, objstat, tstpnm, timestmp, progname FROM rsts WHERE transtru = '${n}'`,
    10,
  );
  if (versions.length === 0) {
    // A DataSource name: its assignments, and the transfer rules of the single one if unique.
    const maps = await queryTable(
      client,
      `SELECT oltpsource, logsys, objvers, isource, transtru FROM rsisosmap WHERE oltpsource = '${n}'`,
      50,
    );
    const structures = [...new Set(maps.map((m) => m.TRANSTRU).filter(Boolean))];
    if (structures.length !== 1) return listTransferRules(client, `oltpsource = '${n}'`, `of ${name.toUpperCase()}`);
    versions = await queryTable(
      client,
      `SELECT transtru, objvers, logsys, startroutine, glbcode, objstat, tstpnm, timestmp, progname FROM rsts ` +
        `WHERE transtru = '${sqlLiteral(structures[0])}'`,
      10,
    );
    if (versions.length === 0) return listTransferRules(client, `oltpsource = '${n}'`, `of ${name.toUpperCase()}`);
  }

  const head = [...headsBy(versions, (r) => r.TRANSTRU).values()][0];
  const ts = sqlLiteral(head.TRANSTRU);
  const v = sqlLiteral(head.OBJVERS);
  const [map] = await queryTable(
    client,
    `SELECT oltpsource, logsys, isource, istype FROM rsisosmap WHERE transtru = '${ts}' AND objvers = '${v}'`,
    5,
  );
  const rules = await queryTable(
    client,
    `SELECT comstru, iobjnm, iobjnm_ts, fixed_value, convrout_l, convrout_g, formula_id FROM rstsrules ` +
      `WHERE transtru = '${ts}' AND objvers = '${v}'`,
    2000,
  );
  const code = await readCode(client, [head.GLBCODE, head.STARTROUTINE, ...rules.map((r) => r.CONVROUT_L)], head.OBJVERS);

  const out: string[] = [];
  out.push(`Transfer Rules: ${head.TRANSTRU}`);
  out.push('Source: metadata tables (3.x data flow — no release publishes a REST resource for it)');
  if (map) {
    out.push(`DataSource:   ${map.OLTPSOURCE} (source system ${map.LOGSYS})`);
    out.push(`InfoSource:   ${map.ISOURCE}${REQUEST_TYPES[map.ISTYPE] ? ` — ${REQUEST_TYPES[map.ISTYPE]}` : ''}`);
  }
  out.push(...versionLine(head));
  out.push(`Program:      ${head.PROGNAME || '(not generated)'}`);
  out.push(`Last changed: ${formatStamp(head.TIMESTMP) || '?'} by ${head.TSTPNM || '(unknown)'}`);
  out.push(...inactiveNote(head));

  out.push('');
  out.push(`── Rules (${rules.length}) ──`);
  if (rules.length === 0) out.push('  (none)');
  for (const r of rules) {
    const routine = r.CONVROUT_L && !/^0*$/.test(r.CONVROUT_L);
    const kind = routine ? 'ROUTINE' : r.FORMULA_ID ? 'FORMULA' : r.FIXED_VALUE ? 'CONSTANT' : r.IOBJNM_TS ? 'DIRECT' : 'NONE';
    const from = routine
      ? `routine (code id ${r.CONVROUT_L})`
      : r.FORMULA_ID
        ? `formula ${r.FORMULA_ID}`
        : r.FIXED_VALUE
          ? `constant '${r.FIXED_VALUE}'`
          : r.IOBJNM_TS || '(not filled)';
    out.push(`  [${kind}] ${r.IOBJNM} <- ${from}${r.CONVROUT_G ? `   (global conversion ${r.CONVROUT_G})` : ''}`);
  }

  out.push('');
  out.push('── Routines ──');
  const fixed: [string, string][] = [
    ['globalPart', head.GLBCODE],
    ['startRoutine', head.STARTROUTINE],
  ];
  for (const [label, codeId] of fixed) {
    const src = codeId ? code.get(codeId) ?? '' : '';
    if (!hasStatements(src)) {
      out.push(`  ${label}: (none)`);
      continue;
    }
    out.push(`  ${label}: (code id ${codeId})`);
    out.push(indent(src));
  }
  for (const r of rules) {
    const src = r.CONVROUT_L ? code.get(r.CONVROUT_L) : undefined;
    if (!src?.trim()) continue;
    out.push(`  routine for ${r.IOBJNM} (code id ${r.CONVROUT_L}):`);
    out.push(indent(src));
  }
  return out.join('\n');
}

// ── 3.x DataSources (ISFS) ──────────────────────────────────────────────────

/** RSOLTPSOURCE-TYPE. */
const DATASOURCE_TYPES: Record<string, string> = { D: 'transaction data', M: 'master data attributes', T: 'texts', H: 'hierarchies' };

/**
 * An export DataSource (name starting with 8) is generated by BW itself when an InfoProvider
 * feeds another one through the data mart interface. It is plumbing, not extraction logic:
 * no one built it, and it disappears with the flow it serves.
 */
const isExport = (name: string) => name.startsWith('8');

export async function readDataSource3x(client: BwClient, name: string): Promise<string> {
  const where = name.includes('*') ? `oltpsource LIKE '${toLike(name)}'` : `oltpsource = '${sqlLiteral(name.trim().toUpperCase())}'`;
  const rows = await queryTable(
    client,
    `SELECT oltpsource, logsys, objvers, type, applnm, delta, tstpnm, timestmp FROM rsoltpsource WHERE ${where}`,
    5000,
  );
  const heads = headsBy(rows, (r) => `${r.OLTPSOURCE}/${r.LOGSYS}`);
  if (heads.size === 0) {
    return `No 3.x DataSource ${name.includes('*') ? 'matches' : 'is named'} ${name.toUpperCase()} (RSOLTPSOURCE). ` +
      `A DataSource of the 7.x type (RSDS) is read with bw_read type="rsds" instead.`;
  }
  const names = [...new Set([...heads.values()].map((h) => h.OLTPSOURCE))];
  const texts = await readTexts(client, 'rsoltpsourcet', 'oltpsource', names);

  // The InfoSource each one feeds, and whether it was migrated to a 7.x DataSource (RSDS).
  const feeds = new Map<string, string>();
  const migrated = new Set<string>();
  for (const batch of inListBatches(names, 150)) {
    for (const m of await queryTable(client, `SELECT oltpsource, logsys, isource FROM rsisosmap WHERE objvers = 'A' AND oltpsource IN (${batch})`, 5000)) {
      feeds.set(`${m.OLTPSOURCE}/${m.LOGSYS}`, m.ISOURCE);
    }
    for (const d of await queryTable(client, `SELECT datasource, logsys FROM rsds WHERE objvers = 'A' AND datasource IN (${batch})`, 5000)) {
      migrated.add(`${d.DATASOURCE}/${d.LOGSYS}`);
    }
  }

  const out = [`3.x DataSources ${name.includes('*') ? `matching ${name.toUpperCase()}` : name.toUpperCase()}: ${heads.size} (${versionCounts(heads.values())})`, ''];
  const sorted = [...heads.values()].sort((a, b) => rank(a.OBJVERS) - rank(b.OBJVERS) || a.OLTPSOURCE.localeCompare(b.OLTPSOURCE));
  for (const h of sorted) {
    const key = `${h.OLTPSOURCE}/${h.LOGSYS}`;
    const bits = [
      VERSION_LABEL[h.OBJVERS] ?? h.OBJVERS,
      DATASOURCE_TYPES[h.TYPE] ?? (h.TYPE ? `type ${h.TYPE}` : ''),
      isExport(h.OLTPSOURCE) ? 'export DataSource (generated)' : '',
      h.DELTA ? `delta ${h.DELTA}` : '',
      feeds.has(key) ? `feeds ${feeds.get(key)}` : '',
      migrated.has(key) ? 'migrated to RSDS' : '',
    ].filter(Boolean);
    const text = texts.get(h.OLTPSOURCE);
    out.push(`  ${h.OLTPSOURCE}  ${h.LOGSYS}${text ? ` — ${text}` : ''}  [${bits.join(', ')}]`);
  }
  out.push('');
  out.push('Export DataSources (names starting with 8) are generated by BW for data mart loads');
  out.push('between providers; they carry no extraction logic of their own.');
  return out.join('\n');
}

// ── 3.x InfoSources (ISTD) ──────────────────────────────────────────────────

/** RSIS-ISSRCTYPE. */
const INFOSOURCE_ORIGIN: Record<string, string> = { '': 'built', I: 'generated from InfoCube', O: 'generated from DSO' };

export async function readInfoSource3x(client: BwClient, name: string): Promise<string> {
  const pattern = name.includes('*');
  const where = pattern ? `isource LIKE '${toLike(name)}'` : `isource = '${sqlLiteral(name.trim().toUpperCase())}'`;
  const rows = await queryTable(
    client,
    `SELECT isource, objvers, applnm, comstru, issrctype, tstpnm, timestmp FROM rsis WHERE ${where}`,
    5000,
  );
  const heads = headsBy(rows, (r) => r.ISOURCE);
  if (heads.size === 0) {
    return `No 3.x InfoSource ${pattern ? 'matches' : 'is named'} ${name.toUpperCase()} (RSIS). ` +
      `A 7.x InfoSource is read with bw_read type="trcs" instead.`;
  }
  const names = [...heads.keys()];
  const texts = await readTexts(client, 'rsist', 'isource', names);

  if (pattern || heads.size > 1) {
    const out = [`3.x InfoSources matching ${name.toUpperCase()}: ${heads.size} (${versionCounts(heads.values())})`, ''];
    const sorted = [...heads.values()].sort((a, b) => rank(a.OBJVERS) - rank(b.OBJVERS) || a.ISOURCE.localeCompare(b.ISOURCE));
    for (const h of sorted) {
      const text = texts.get(h.ISOURCE);
      const bits = [VERSION_LABEL[h.OBJVERS] ?? h.OBJVERS, INFOSOURCE_ORIGIN[h.ISSRCTYPE] ?? `origin ${h.ISSRCTYPE}`, h.APPLNM].filter(Boolean);
      out.push(`  ${h.ISOURCE}${text ? ` — ${text}` : ''}  [${bits.join(', ')}]`);
    }
    out.push('', 'Read one with object_type="ISTD" and its name.');
    return out.join('\n');
  }

  const head = [...heads.values()][0];
  const is = sqlLiteral(head.ISOURCE);
  const v = sqlLiteral(head.OBJVERS);
  const fields = head.COMSTRU
    ? await queryTable(client, `SELECT posit, iobjnm FROM rsksfield WHERE comstru = '${sqlLiteral(head.COMSTRU)}' AND objvers = '${v}'`, 2000)
    : [];
  const sources = await queryTable(client, `SELECT oltpsource, logsys, transtru FROM rsisosmap WHERE isource = '${is}' AND objvers = '${v}'`, 500);
  const targets = await queryTable(client, `SELECT updid, infocube FROM rsupdinfo WHERE isource = '${is}' AND objvers = '${v}'`, 500);

  const out: string[] = [];
  out.push(`InfoSource (3.x): ${head.ISOURCE}`);
  out.push('Source: metadata tables (3.x data flow — no release publishes a REST resource for it)');
  const text = texts.get(head.ISOURCE);
  if (text) out.push(`Description:  ${text}`);
  out.push(`Application:  ${head.APPLNM || '(none)'}`);
  out.push(`Origin:       ${INFOSOURCE_ORIGIN[head.ISSRCTYPE] ?? head.ISSRCTYPE}`);
  out.push(`Comm. struct: ${head.COMSTRU || '(none)'}`);
  out.push(...versionLine(head));
  out.push(`Last changed: ${formatStamp(head.TIMESTMP) || '?'} by ${head.TSTPNM || '(unknown)'}`);
  out.push(...inactiveNote(head));

  out.push('');
  out.push(`── Fields (${fields.length}) ──`);
  for (const f of fields.sort((a, b) => Number(a.POSIT) - Number(b.POSIT))) out.push(`  ${f.IOBJNM}`);
  if (fields.length === 0) out.push('  (none)');

  out.push('');
  out.push(`── DataSources (${sources.length}, transfer rules) ──`);
  for (const s of sources) out.push(`  ${s.OLTPSOURCE}  ${s.LOGSYS}${s.TRANSTRU ? `  transfer structure ${s.TRANSTRU}` : ''}`);
  if (sources.length === 0) out.push('  (none)');

  out.push('');
  out.push(`── Data Targets (${targets.length}, update rules) ──`);
  for (const t of targets) out.push(`  ${t.INFOCUBE}  update rules ${t.UPDID}`);
  if (targets.length === 0) out.push('  (none)');
  return out.join('\n');
}
