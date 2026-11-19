import assert from 'node:assert/strict';
import test from 'node:test';

for (const key of Object.keys(process.env)) if (key.startsWith('BW_')) delete process.env[key];
const { bwReadMetadataTables } = await import('../dist/tools/metadata_tables.js');

/** DataPreview answer in the column-oriented format the service returns. */
function preview(rows) {
  const names = rows.length ? Object.keys(rows[0]) : [];
  return names.map((name) => `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}"/><dataPreview:dataSet>` +
    rows.map((r) => (r[name] === '' ? '<dataPreview:data/>' : `<dataPreview:data>${r[name]}</dataPreview:data>`)).join('') +
    '</dataPreview:dataSet></dataPreview:columns>').join('');
}

/** A client whose DataPreview answers by table, recording each statement. */
function fakeClient(tables) {
  const statements = [];
  return {
    statements,
    async getCsrfToken() { return 'token'; },
    clearCsrfToken() {},
    async rawPost(url, sql) {
      statements.push(sql);
      assert.ok(sql.length <= 255, `statement longer than DataPreview parses: ${sql}`);
      const table = sql.match(/\bFROM (\w+)/i)[1].toLowerCase();
      // Equality conditions on columns the fake rows carry; the rest of the WHERE is ignored.
      const conditions = [...sql.matchAll(/\b(\w+) (=|<>) '([^']*)'/g)].map(([, c, op, v]) => [c.toUpperCase(), op, v]);
      const rows = (tables[table] ?? []).filter((r) => conditions.every(([c, op, v]) => !(c in r) || (op === '=' ? r[c] === v : r[c] !== v)));
      return { body: preview(rows), headers: {} };
    },
  };
}

const UPDID = 'ZZUPD000000000000000000A1';
const tables = {
  rsupdinfo: [
    { UPDID, OBJVERS: 'A', INFOCUBE: 'ZSALES01', ISOURCE: 'ZIS_SALES', STARTROUTINE: '9998', EXPERTMODE: '', OBJSTAT: 'ACT', TSTPNM: 'DEV', TIMESTMP: '20190301100000', URPROGID: 'GP0001' },
    { UPDID, OBJVERS: 'D', INFOCUBE: 'ZSALES01', ISOURCE: 'ZIS_SALES', STARTROUTINE: '0000', EXPERTMODE: '', OBJSTAT: '', TSTPNM: 'SAP', TIMESTMP: '20050101000000', URPROGID: '' },
  ],
  rsupddat: [
    { RULENO: '0001', UPDTYPE: 'ADD', CALCTPDAT: '1', ICIOBJNM: 'ZAMOUNT', CSIOBJNM: 'ZAMOUNT', ROUTINE: '0000', CONSTANT: '', UNITCONV: '', FRMLAID: '' },
    { RULENO: '0002', UPDTYPE: 'ADD', CALCTPDAT: '3', ICIOBJNM: 'ZQTY', CSIOBJNM: '', ROUTINE: '0002', CONSTANT: '', UNITCONV: '', FRMLAID: '' },
  ],
  rsupdkey: ['0001', '0002'].flatMap((RULENO) => [
    { RULENO, POSIT: '0001', ICIOBJNM: '0CUSTOMER', CSIOBJNM: '0CUSTOMER', ROUTINE: '0000', CALCTPKEY: '1', CONSTANT: '', CMIOBJNM: '', FORMULA_ID: '', CSPLITIOBJNM: '' },
    { RULENO, POSIT: '0002', ICIOBJNM: '0COUNTRY', CSIOBJNM: '0CUSTOMER', ROUTINE: '0000', CALCTPKEY: '5', CONSTANT: '', CMIOBJNM: '0COUNTRY', FORMULA_ID: '', CSPLITIOBJNM: '' },
  ]),
  rsupdrout: [
    { UPDID, OBJVERS: 'A', ROUTINE: '9999', ICIOBJNM: '', CODEID: 'GLOBAL' },
    { UPDID, OBJVERS: 'A', ROUTINE: '9998', ICIOBJNM: '', CODEID: 'START' },
    { UPDID, OBJVERS: 'A', ROUTINE: '0002', ICIOBJNM: 'ZQTY', CODEID: 'QTY' },
  ],
  rsaabap: [
    { CODEID: 'GLOBAL', LINE_NO: '000001', LINE: '* DATA: ...' },
    { CODEID: 'START', LINE_NO: '000002', LINE: '  SELECT * FROM /bic/azsales00 INTO TABLE gt_old.' },
    { CODEID: 'START', LINE_NO: '000001', LINE: '  DELETE DATA_PACKAGE WHERE amount = 0.' },
    { CODEID: 'QTY', LINE_NO: '000001', LINE: '  RESULT = COMM_STRUCTURE-qty * 2.' },
  ],
  rsist: [{ ISOURCE: 'ZIS_SALES', LANGU: 'E', TXTLG: 'Sales' }],
};

test('update rules come back with their rules, one characteristic set and the routine code in line order', async () => {
  const client = fakeClient(tables);
  const text = await bwReadMetadataTables(client, 'UPDR', UPDID);
  assert.match(text, /^Target: {7}ZSALES01$/m);
  assert.match(text, /^InfoSource: {3}ZIS_SALES — Sales$/m);
  assert.match(text, /^Version: {6}A — active\n {14}\(also present as D\)$/m);
  assert.match(text, /\[SOURCE_INFOOBJECT\] ZAMOUNT <- ZAMOUNT {3}\(addition, source InfoObject, characteristics: set 1\)/);
  assert.match(text, /\[ROUTINE\] ZQTY <- routine 0002/);
  assert.match(text, /── Characteristic Rules \(1 set\) ──\n {2}set 1 — used by rules 0001, 0002:/);
  assert.match(text, /\[MASTER_DATA_READ\] 0COUNTRY <- master data of 0CUSTOMER \(attribute 0COUNTRY\)/);
  assert.match(text, /globalPart: \(none\)/);
  assert.match(text, /startRoutine: \(code id START\)\n {6} {2}DELETE DATA_PACKAGE WHERE amount = 0\.\n {6} {2}SELECT/);
  assert.match(text, /routine 0002 \(ZQTY, code id QTY\):/);
  assert.doesNotMatch(text, /NOTE: no active version/);
});

test('a provider name lists the update rules that load it; a pattern lists every version', async () => {
  const byTarget = await bwReadMetadataTables(fakeClient(tables), 'UPDR', 'ZSALES01');
  // Two versions of one update rule are one object, shown in its active version.
  assert.match(byTarget, /Update rules \(3\.x\) loading ZSALES01: 1 \(active 1, modified 0, delivered 0\)/);
  const all = await bwReadMetadataTables(fakeClient({ ...tables, rsupdinfo: [...tables.rsupdinfo, { ...tables.rsupdinfo[1], UPDID: 'DELIVERED0000000000000001', INFOCUBE: '0CUBE' }] }), 'UPDR', '*');
  assert.match(all, /matching \*: 2 \(active 1, modified 0, delivered 1\)/);
  assert.match(all, /  DELIVERED0000000000000001  0CUBE <- ZIS_SALES  \[delivered content \(not installed\), routines 0,/);
  assert.match(byTarget, new RegExp(`  ${UPDID}  ZSALES01 <- ZIS_SALES  \\[active, routines 2, start routine,`));
});

test('the type is validated against the name width and unknown types list the 3.x ones', async () => {
  const unknown = await bwReadMetadataTables(fakeClient({}), 'XXXX', 'A');
  assert.match(unknown, /UPDR, ISTS, ISFS, ISTD/);
  const tooLong = await bwReadMetadataTables(fakeClient({}), 'ISFS', 'X'.repeat(31));
  assert.match(tooLong, /at most 30/);
});
