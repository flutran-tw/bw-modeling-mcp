import test from 'node:test';
import assert from 'node:assert/strict';
import { bwReadMetadataTables } from '../dist/tools/metadata_tables.js';

const trfn = `<trfn:transformation>
<rule id="1" routinetype="START"><step xsi:type="trfn:StepRoutine" classNameM="/BIC/CLS_M" methodNameM="START"/></rule>
<rule id="2" routinetype="END"><step classNameM="/BIC/CLS_M" methodNameM="END_RT"/></rule>
<rule id="3" routinetype="EXPERT"><step classNameM="/BIC/CLS_M" methodNameM="EXPERT"/></rule>
<rule id="4"><step xsi:type="trfn:StepRoutine" classNameM="/BIC/CLS_M" methodNameM="FIELD_4"/><target><elementRef>#///target/segment1/AMOUNT</elementRef></target></rule>
<rule id="5"><step xsi:type="trfn:StepDirect"/></rule>
<rule id="6"><step classNameM="/BIC/CLS_M" methodNameM="MISSING"/></rule>
</trfn:transformation>`;
const cls = `CLASS /bic/cls_m DEFINITION.
ENDCLASS.
CLASS /bic/cls_m IMPLEMENTATION.
  METHOD start BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT OPTIONS READ-ONLY.
    outTab = SELECT * FROM :inTab WHERE amount <> 0;
  ENDMETHOD.
  METHOD end_rt BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT.
    outTab = SELECT * FROM :inTab;
  ENDMETHOD.
  METHOD expert BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT.
    outTab = SELECT * FROM :inTab;
  ENDMETHOD.
  METHOD field_4.
    result = source_fields-amount * 2.
  ENDMETHOD.
ENDCLASS.`;
const client = (urls = []) => ({ async get(path) {
  urls.push(path);
  if (path.includes('/trfn/')) return { body: trfn };
  if (path.includes('/oo/classes/%2fbic%2fcls_m/source/main?version=active')) return { body: cls };
  throw new Error('HTTP 404');
} });

test('AMDP: every routine kind comes back with its own method body', async () => {
  const urls = [];
  const r = JSON.parse(await bwReadMetadataTables(client(urls), 'AMDP', 'ABC'));
  assert.equal(r.transformation, 'ABC');
  assert.deepEqual(r.routines.map((x) => [x.kind, x.method, x.found, x.language]), [
    ['start', 'START', true, 'amdp'], ['end', 'END_RT', true, 'amdp'], ['expert', 'EXPERT', true, 'amdp'],
    ['field', 'FIELD_4', true, 'abap'], ['field', 'MISSING', false, null],
  ]);
  assert.match(r.routines[0].code, /^\s*METHOD start[\s\S]*amount <> 0;\s*ENDMETHOD\.$/);
  assert.ok(!r.routines[0].code.includes('end_rt'));
  assert.deepEqual(r.routines[3].targets, ['AMOUNT']);
  assert.deepEqual(r.unmatched, ['/BIC/CLS_M.MISSING']);
  assert.deepEqual(r.classes, [{ name: '/BIC/CLS_M', found: true, lines: cls.split('\n').length }]);
  assert.equal(urls.filter((u) => u.includes('/oo/classes/')).length, 1, 'one class is read once');
});
