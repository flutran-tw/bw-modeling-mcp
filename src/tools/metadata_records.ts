import { XMLParser } from 'fast-xml-parser';
import { BwClient, MEDIA_TYPES, bwSeg } from '../bw-client.js';
import { queryTable, sqlLiteral } from './metadata_sql.js';

interface CountTable { name: string; records?: string }

/** Physical stored rows, never the sum of historical load requests. */
export async function readRecordCount(client: BwClient, object: string): Promise<string> {
  const match = object.toUpperCase().match(/^(ADSO|IOBJ|ODSO|CUBE):([A-Z0-9_/$]+)$/);
  if (!match || match[2].length > 30) throw new Error('RECORDS requires object_name="ADSO|IOBJ|ODSO|CUBE:NAME" (name at most 30 characters).');
  const [, type, name] = match;
  const tables: CountTable[] = [];
  let basis = '';
  try {
    if (type === 'ADSO' || type === 'IOBJ') {
      const resource = type.toLowerCase();
      const { body } = await client.get(`/sap/bw/modeling/${resource}/${bwSeg(name)}/a`, MEDIA_TYPES[resource]);
      const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true }).parse(body);
      if (type === 'ADSO') {
        const root = parsed.dataStore;
        if (!root) throw new Error('No active aDSO definition.');
        const on = (key: string) => root[key] === 'true' || root[key] === true;
        const roles = on('cubeDeltaOnly') ? ['AT', 'AQ'] : on('activateData') || on('directUpdate') ? ['AT'] : ['AQ'];
        basis = roles.length === 2 ? 'Active + inbound rows' : roles[0] === 'AT' ? 'Active data rows' : 'Inbound rows';
        const generated = Array.isArray(root.tables) ? root.tables : root.tables ? [root.tables] : [];
        for (const role of roles) {
          const table = generated.find((t: Record<string, string>) => t.tableType === role && t.ddicStatus === 'A');
          if (!table?.tableName) throw new Error(`No active generated ${role} table.`);
          tables.push({ name: table.tableName });
        }
      } else {
        // The view joins P and Q; summing them would count master data twice.
        const root = parsed.infoObject;
        if (!root) throw new Error('No active InfoObject definition.');
        const master = root.masterDataProperties;
        const candidates = [master?.masterDataView, master?.masterDataTable, root.textProperties?.textTable];
        const table = candidates.find((t) => t?.name && t.status === 'A');
        if (!table) throw new Error('No active master data or text table.');
        basis = table === root.textProperties?.textTable ? 'Text rows' : 'Master data rows (including validity intervals)';
        tables.push({ name: table.name });
      }
    } else {
      const cube = type === 'CUBE';
      const [head] = await queryTable(client, cube
        ? `SELECT cubetype FROM rsdcube WHERE infocube = '${sqlLiteral(name)}' AND objvers = 'A'`
        : `SELECT odsotype FROM rsdodso WHERE odsobject = '${sqlLiteral(name)}' AND objvers = 'A'`, 1);
      if (!head) throw new Error('No active provider definition.');
      if (cube && !['B', 'A'].includes(head.CUBETYPE)) throw new Error('No local stored fact tables for this provider type.');
      const objectNamespace = name.match(/^\/[^/]+\//)?.[0];
      const namespaces = objectNamespace
        ? await queryTable(client, `SELECT namespace, nspacegen FROM rspspace WHERE namespace = '${sqlLiteral(objectNamespace)}'`, 1)
        : await queryTable(client, "SELECT namespace, nspacegen FROM rsnspace WHERE active = 'X'", 500);
      const mapping = namespaces.filter((r) => name.startsWith(r.NAMESPACE)).sort((a, b) => b.NAMESPACE.length - a.NAMESPACE.length)[0];
      if (!mapping?.NSPACEGEN) throw new Error('Generated namespace could not be resolved.');
      const localName = objectNamespace ? name.slice(mapping.NAMESPACE.length) : name;
      const candidates = cube ? [`${mapping.NSPACEGEN}F${localName}`, `${mapping.NSPACEGEN}E${localName}`]
        : [`${mapping.NSPACEGEN}A${localName}00`];
      basis = cube ? 'Stored fact rows (F + E)' : 'Active data rows';
      for (const table of candidates) {
        const existing = await queryTable(client, `SELECT tabname FROM dd02l WHERE tabname = '${sqlLiteral(table)}' AND as4local = 'A'`, 1);
        if (existing.length) tables.push({ name: table });
        else if (!cube) throw new Error('Active data table is not generated.');
      }
      if (!tables.length) throw new Error('No generated fact tables.');
    }
    let total = 0n;
    for (const table of tables) {
      if (!/^(?:\/[A-Z0-9_]+\/)?[A-Z0-9_]+$/.test(table.name)) throw new Error('Invalid generated table name.');
      const [row] = await queryTable(client, `SELECT count(*) AS cnt FROM ${table.name}`, 1);
      if (!/^\d+$/.test(row?.CNT ?? '')) throw new Error(`No row count returned for ${table.name}.`);
      table.records = row.CNT;
      total += BigInt(row.CNT);
    }
    return JSON.stringify({ recordCount: String(total), recordCountBasis: basis, recordCountTables: tables });
  } catch (err) {
    return JSON.stringify({ recordCount: null, recordCountBasis: basis, recordCountTables: tables,
      recordCountError: String((err as Error).message).slice(0, 400) });
  }
}
