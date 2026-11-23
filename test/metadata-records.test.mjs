import test from 'node:test';
import assert from 'node:assert/strict';
import { bwReadMetadataTables } from '../dist/tools/metadata_tables.js';

function preview(rows) {
  return Object.keys(rows[0] || {}).map((key) => `<dataPreview:columns><dataPreview:metadata dataPreview:name="${key}"/><dataPreview:dataSet>${rows.map((r) => `<dataPreview:data>${r[key]}</dataPreview:data>`).join('')}</dataPreview:dataSet></dataPreview:columns>`).join('');
}

function client({ xml = '', counts = {}, cubeType = 'B', namespace = '', generated = '/BIC/' } = {}) {
  const statements = [];
  return {
    statements,
    async get() { return { body: xml }; },
    async getCsrfToken() { return 'token'; },
    async rawPost(url, sql) {
      statements.push(sql);
      assert.ok(sql.length <= 255);
      let rows;
      if (sql.includes('FROM rsdcube')) rows = [{ CUBETYPE: cubeType }];
      else if (sql.includes('FROM rsdodso')) rows = [{ ODSOTYPE: '' }];
      else if (sql.includes('FROM rsnspace')) rows = [{ NAMESPACE: '', NSPACEGEN: '/BIC/' }, { NAMESPACE: namespace, NSPACEGEN: generated }];
      else if (sql.includes('FROM rspspace')) rows = [{ NAMESPACE: namespace, NSPACEGEN: generated }];
      else if (sql.includes('FROM dd02l')) {
        const name = sql.match(/tabname = '([^']+)'/)[1];
        rows = name in counts ? [{ TABNAME: name }] : [];
      } else {
        const name = sql.match(/FROM (\S+)/)[1];
        if (!(name in counts) || counts[name] instanceof Error) throw counts[name] || new Error('Table unavailable');
        rows = [{ CNT: counts[name] }];
      }
      return { body: preview(rows) };
    },
  };
}

const read = async (c, name) => JSON.parse(await bwReadMetadataTables(c, 'RECORDS', name));
const adso = (flags) => `<adso:dataStore ${flags}><tables tableName="/BIC/AZORDERS1" tableType="AQ" ddicStatus="A"/><tables tableName="/BIC/AZORDERS2" tableType="AT" ddicStatus="A"/><tables tableName="/BIC/AZORDERS3" tableType="CL" ddicStatus="A"/></adso:dataStore>`;

test('aDSO counts active, inbound or both according to its model, excluding change logs', async () => {
  for (const [flags, total, tableCount] of [
    ['activateData="true"', '5', 1], ['activateData="false"', '12', 1],
    ['directUpdate="true"', '5', 1], ['activateData="true" cubeDeltaOnly="true"', '17', 2],
  ]) {
    const result = await read(client({ xml: adso(flags), counts: { '/BIC/AZORDERS1': '12', '/BIC/AZORDERS2': '5' } }), 'ADSO:ZORDERS');
    assert.equal(result.recordCount, total);
    assert.equal(result.recordCountTables.length, tableCount);
    assert.ok(!result.recordCountTables.some((t) => t.name.endsWith('3')));
  }
});

test('InfoObject uses the master-data view without summing attributes, texts and SIDs', async () => {
  const xml = '<iobj:infoObject><masterDataProperties><masterDataView name="/BIC/MZCUSTOMER" status="A"/><masterDataTable name="/BIC/PZCUSTOMER" status="A"/></masterDataProperties><textProperties><textTable name="/BIC/TZCUSTOMER" status="A"/></textProperties></iobj:infoObject>';
  const result = await read(client({ xml, counts: { '/BIC/MZCUSTOMER': '0' } }), 'IOBJ:ZCUSTOMER');
  assert.equal(result.recordCount, '0');
  assert.equal(result.recordCountTables.length, 1);
});

test('classic providers resolve generated namespaces and count active or fact tables', async () => {
  const dso = await read(client({ counts: { '/BIC/AZORDERS00': '29' } }), 'ODSO:ZORDERS');
  assert.equal(dso.recordCount, '29');
  const cube = await read(client({ namespace: '/ACME/', generated: '/B99/', counts: { '/B99/FORDERS': '9007199254740993', '/B99/EORDERS': '7' } }), 'CUBE:/ACME/ORDERS');
  assert.equal(cube.recordCount, '9007199254741000');
  assert.equal(cube.recordCountTables.length, 2);
  const hana = await read(client({ counts: { '/BIC/FZORDERS': '8' } }), 'CUBE:ZORDERS');
  assert.equal(hana.recordCount, '8', 'a cube may have only one generated fact table');
});

test('missing storage and failed counts remain unknown rather than becoming zero or a partial total', async () => {
  const virtual = client({ cubeType: 'V' });
  assert.equal((await read(virtual, 'CUBE:VIRTUAL')).recordCount, null);
  assert.ok(!virtual.statements.some((s) => /count\(/.test(s)));
  const missing = await read(client(), 'ODSO:NOTGENERATED');
  assert.equal(missing.recordCount, null);
  const partial = await read(client({ counts: { '/BIC/FZORDERS': '8', '/BIC/EZORDERS': new Error('Access denied') } }), 'CUBE:ZORDERS');
  assert.equal(partial.recordCount, null);
  assert.match(partial.recordCountError, /Access denied/);
});

test('caller input cannot become SQL identifiers or unrestricted table access', async () => {
  const c = client();
  for (const value of ['DD02L:ANY', 'ADSO:Z;DELETE', "CUBE:X' OR '1'='1", `ADSO:${'A'.repeat(31)}`]) {
    await assert.rejects(() => read(c, value), /RECORDS requires/);
  }
  assert.equal(c.statements.length, 0);
});
