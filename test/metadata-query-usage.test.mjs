import test from 'node:test';
import assert from 'node:assert/strict';
import { bwReadMetadataTables } from '../dist/tools/metadata_tables.js';

const dim = (axis, name, presentation = '<Qry:valuePresentation default="true"/>') =>
  `<Qry:${axis} xsi:type="Qry:Dimension" infoObjectName="${name}"><Qry:additionalInfo><Qry:keyValuePairs key="infoObjectType" value="CHA"/></Qry:additionalInfo>${presentation}</Qry:${axis}>`;
const query = (main) => `<Qry:queryResource xmlns:Qry="q" xmlns:xsi="x"><Qry:mainComponent xsi:type="Qry:Query">${main}</Qry:mainComponent></Qry:queryResource>`;
const client = (body) => ({ async get() { return { body }; } });

test('QUSE: texts follow the presentation, navigation attributes are found anywhere', async () => {
  const xml = query([
    dim('rows', 'ZGL'),
    dim('rows', 'ZKEY', '<Qry:valuePresentation default="false" presentAs="Key" textPresentation="standard"/>'),
    dim('free', 'ZBOTH', '<Qry:valuePresentation default="false" presentAs="KeyAndText" textPresentation="short"/>'),
    dim('free', 'ZHIDE', '<Qry:valuePresentation default="false" presentAs="noDisplay"/>'),
    dim('free', 'ZGL__ZFLAG'),
    '<Qry:filter><Qry:selections infoObject="ZCC__ZREGION"/></Qry:filter>',
  ].join(''));
  const r = JSON.parse(await bwReadMetadataTables(client(xml), 'QUSE', 'Q1'));
  assert.deepEqual(r.texts, ['ZBOTH', 'ZGL']);
  assert.deepEqual(r.navigationAttributes, [{ infoObject: 'ZGL', attribute: 'ZFLAG' }, { infoObject: 'ZCC', attribute: 'ZREGION' }]);
});
