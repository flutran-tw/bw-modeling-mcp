import { BwClient } from '../bw-client.js';
import { queryTable } from './metadata_sql.js';

/** "0002" -> "SP02". CVERS-EXTRELEASE is the support package level of the component. */
const supportPackage = (ext: string) => `SP${String(Number(ext) || 0).padStart(2, '0')}`;

/**
 * The installed release, from the software component table CVERS — the same thing
 * System > Status shows in the SAP GUI. The systeminfo service carries no release:
 * its server_version is a number of the modeling backend, not the SAP_BW release.
 * BW/4HANA runs on DW4CORE, BW embedded in S/4HANA comes with S4CORE.
 */
export async function readSoftware(client: BwClient): Promise<string> {
  try {
    const rows = await queryTable(
      client,
      "SELECT component, release, extrelease FROM cvers WHERE component IN ('SAP_BW', 'SAP_BASIS', 'DW4CORE', 'S4CORE')",
      10,
    );
    const by = new Map(rows.map((r) => [r.COMPONENT, `${r.COMPONENT} ${r.RELEASE} ${supportPackage(r.EXTRELEASE)}`]));
    const parts = ['DW4CORE', 'SAP_BW', 'SAP_BASIS'].map((c) => by.get(c)).filter(Boolean);
    if (parts.length === 0) return '? (no BW component in CVERS)';
    const host = by.has('S4CORE') ? ` — embedded in SAP S/4HANA (${by.get('S4CORE')})` : '';
    return `${parts.join(', ')}${host}`;
  } catch (e) {
    return `? (CVERS not readable: ${String((e as Error).message).split('\n')[0]})`;
  }
}
