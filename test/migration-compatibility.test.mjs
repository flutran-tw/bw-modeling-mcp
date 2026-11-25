import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// No real credentials or backend connections in these regression tests.
for (const key of Object.keys(process.env)) if (key.startsWith('BW_')) delete process.env[key];
process.env.BW_STDIO_SCOPES = 'read';
const { createServer } = await import('../dist/index.js');
const { mayCall, hasScope, filterToolsByScope } = await import('../dist/scopes.js');
const expectedVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('fork stdio scope keeps transformation/DTP reads and refuses all mutations and unknown tools', () => {
  for (const name of ['bw_get_transformation', 'bw_get_dtp', 'bw_get_dtps', 'bw_read_metadata_tables', 'bw_get_adso']) {
    assert.equal(mayCall(name), true, name);
  }
  for (const name of ['bw_update_transformation', 'bw_run_dtp', 'bw_delete', 'bw_activate', 'bw_unknown_future_tool']) {
    assert.equal(mayCall(name), false, name);
  }
  assert.equal(hasScope(undefined, 'write'), false);
  assert.deepEqual(filterToolsByScope([{ name: 'bw_get_dtp' }, { name: 'bw_run_dtp' }]), [{ name: 'bw_get_dtp' }]);
});

test('explicit HTTP auth scopes keep precedence over the stdio scope', () => {
  const auth = (scopes) => ({ token: 'fixture', clientId: 'test', scopes });
  assert.equal(mayCall('bw_update_transformation', auth(['write'])), true);
  assert.equal(mayCall('bw_get_transformation', auth(['analyst'])), false);
  assert.equal(mayCall('bw_get_dtp', auth(['bwmcp!test.read'])), true);
});

for (const mode of ['focused', 'full']) {
  test(`${mode} MCP handshake, schemas and denied calls preserve read-only access`, async () => {
    process.env.BW_TOOL_MODE = mode;
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({ name: 'fork-regression', version: '1.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      assert.equal(client.getServerVersion().version, expectedVersion);
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0);
      assert.equal(tools.some(t => t.name.startsWith('bw_write_') || ['bw_delete', 'bw_run'].includes(t.name)), false);
      if (mode === 'focused') {
        const read = tools.find(t => t.name === 'bw_read');
        assert.ok(read.inputSchema.properties.type.enum.includes('trfn'));
        assert.ok(read.inputSchema.properties.type.enum.includes('dtpa'));
        assert.deepEqual(tools.find(t => t.name === 'bw_activate').inputSchema.properties.operation.enum, ['check']);
        const description = await client.callTool({ name: 'bw_describe', arguments: { tool: 'bw_read', type: 'trfn' } });
        assert.equal(Boolean(description.isError), false);
        const schema = JSON.parse(description.content[0].text.split('Parameters (JSON Schema):\n')[1]);
        assert.deepEqual(schema.required, ['name']);
        assert.deepEqual(schema.properties.format.enum, ['text', 'raw']);
        const rejected = await client.callTool({ name: 'bw_write_transformation', arguments: { operation: 'create' } });
        assert.equal(rejected.isError, true);
      } else {
        assert.ok(tools.some(t => t.name === 'bw_get_transformation'));
        assert.ok(tools.some(t => t.name === 'bw_get_dtp'));
        assert.equal(tools.some(t => t.name === 'bw_update_transformation'), false);
      }
      // A legacy full-name call must not bypass the filter, including in focused mode.
      await assert.rejects(client.callTool({ name: 'bw_update_transformation', arguments: {} }), /requires.*scope/i);
    } finally {
      await client.close();
      await server.close();
    }
  });
}

const moduleUrl = new URL('../dist/bw-client.js', import.meta.url).href;
const probe = `
  const { BwClient } = await import(${JSON.stringify(moduleUrl)});
  const client = new BwClient({ url: 'https://example.invalid', auth: { kind: 'basic', user: 'test', password: 'test' } });
  const options = client.http.defaults.httpsAgent.options;
  console.log(JSON.stringify({ verify: options.rejectUnauthorized, count: options.ca?.length ?? 0, custom: options.ca?.includes('TEST-CA') ?? false }));
`;
function tlsProbe(overrides = {}) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    env: { ...process.env, ...overrides }, encoding: 'utf8', timeout: 15000,
  }));
}

test('TLS certificate verification remains enabled by default', () => {
  assert.equal(tlsProbe().verify, true);
});

test('disabling TLS verification requires the explicit upstream opt-out', () => {
  assert.equal(tlsProbe({ BW_TLS_VERIFY: 'off' }).verify, false);
  assert.equal(tlsProbe({ BW_TLS_VERIFY: 'on' }).verify, true);
});
