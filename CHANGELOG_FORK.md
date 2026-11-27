# Changelog

## [2.1.1~franzz2] - 2026-11-27

- Read the source of generated-class routines through `bw_read_metadata_tables` (`bw_find` operation=metadata_tables) with `object_type=AMDP` and the transformation id, in `src/tools/metadata_amdp.ts`. BW/4HANA keeps AMDP (SQLScript) start, end, expert and field routines as methods of the generated class `/BIC/…_M`, which `TRFN` (RSAABAP) does not return. The class and method names come from the transformation definition (`classNameM`, `methodNameM`), the class source from ADT (active version, then inactive), and the result is JSON with one entry per routine: kind, rule, class, method, language (`amdp` or `abap`), code, target fields. Read-only.
- Upstream touch points, to re-check on each merge: `import`, `SUPPORTED`, `NAME_WIDTHS` and `case 'AMDP'` in `src/tools/metadata_tables.ts`, and two description lines in `src/index.ts`.

## [2.1.1~franzz1] - 2026-11-27

- Merge upstream v2.1.1 into bw-migration.
- Conflict in `src/index.ts` (`bw_read_metadata` InfoPackage description): kept our 3.x text (UPDR/ISTS/ISFS/ISTD) and added upstream's new wording on the error messages and files of red requests.

## [2.1.0~franzz1] - 2026-11-25

- Merge upstream v2.1.0 into bw-migration.
- Drop our own TLS handling (`BW_CA_FILE`, `BW_TLS_INSECURE`): upstream now verifies the certificate by default, takes an in-house CA as a PEM file through `NODE_EXTRA_CA_CERTS`, and switches the check off with `BW_TLS_VERIFY=off`. `start-bw-mcp.mjs` sets `NODE_EXTRA_CA_CERTS` to `rootca.pem` and restarts itself, since Node reads that variable only at startup.

## [2.0.0~franzz2] - 2026-11-19

- Read the 3.x data flow from its metadata tables through `bw_read_metadata_tables` (`bw_find` operation=metadata_tables), in `src/tools/metadata_3x.ts`. Classic SAP BW only; none of these objects is in the search index:
  - `UPDR` update rules: target, InfoSource, key figure rules with update and calculation type, characteristic rules (identical sets printed once), global part, start routine and rule routines as ABAP source. A provider name lists the update rules that load it.
  - `ISTS` transfer rules: DataSource, InfoSource, field rules and routines. A DataSource name lists its DataSource-to-InfoSource assignments.
  - `ISFS` 3.x DataSources: type, delta, InfoSource fed, whether a 7.x DataSource (RSDS) of the same name exists; export DataSources (`8*`) flagged as generated.
  - `ISTD` 3.x InfoSources: communication structure fields, DataSources and data targets.
  - A pattern such as `*` lists each type with the version of every object: `A` runs, `M` is an unactivated change, `D` is Business Content never installed.
- `bw_system_profile` adds a `Software:` line with the installed SAP_BW / SAP_BASIS (or DW4CORE) release and support package from CVERS, and S4CORE for BW embedded in S/4HANA (`src/tools/software.ts`). `Server version` is the modeling backend number of the systeminfo service, not the SAP_BW release.

## [2.0.0~franzz1] - 2026-11-13

- Merge upstream v2.0.0 into bw-migration, retaining verified TLS with BW_CA_FILE and stdio scope restrictions.
- Cover focused/full MCP read-only behavior, legacy call scope enforcement and TLS defaults with offline regression tests.
- Classic BW transformation and DTP definitions remain available through bw_find operation=metadata_tables.

## [1.9.1~franzz1] - 2026-11-05

- Verify TLS against BW CA
- Split Scope (read/edit) of MCP actions
