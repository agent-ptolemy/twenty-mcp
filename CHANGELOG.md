# Changelog

All notable changes to Twenty MCP Server will be documented in this file.

## [Unreleased]

### Fixed
- **`get_entity_activities` is now genuinely entity-scoped, and `find_orphaned_records` checks opportunities and tasks (#1).** `get_entity_activities` previously ignored `entityId`/`entityType` and returned the global activity feed, so every company/opportunity/person appeared to share an identical timeline — confidently wrong data for agents. It now scopes through Twenty's relationship model, querying `noteTargets`/`taskTargets` filtered by the entity id (`companyId`/`personId`/`opportunityId`), de-duplicating, sorting newest-first, and honouring `limit`/`offset` against the combined set; an unmappable entity type returns a clear error rather than a misleading global feed. Separately, `find_orphaned_records` declared `opportunities` and `tasks` in its result shape but never queried them, so it always reported `0` regardless of the data; it now detects opportunities missing a company or point of contact (distinguishing the two) and tasks with no assignee, with null/empty connections handled defensively. Unit coverage in `tests/entity-activities-orphans.test.js`, wired into CI.
- **`find_orphaned_records` no longer crashes on null relation connections, and no longer fabricates clean results on failure (#12).** Twenty returns relation connections (`company.people`, `company.opportunities`, `person.opportunities`) as `null` for some records rather than `{ totalCount: 0 }`; the previous code read `.totalCount` unconditionally, throwing `TypeError: Cannot read properties of null (reading 'totalCount')`. Null connections are now treated as a count of `0` (a null connection means "no linked records", which is exactly the orphaned condition — records are never skipped, only counted as 0). Separately, the method previously wrapped its whole body in a `try/catch` that logged a warning and returned empty arrays, so any GraphQL failure surfaced to the user as a false "no orphaned records found". Errors now propagate and the `find_orphaned_records` tool returns a structured `isError` response. Unit coverage in `tests/metadata-orphaned.test.js`.
- **`list_all_objects` now paginates the metadata API and returns all object types, not just the first page (#14).** The `objects` query against Twenty's `/metadata` endpoint was issued with no `paging`/`first` argument, so a workspace's objects were truncated to the server's default page — observed live as only Company / Task / Opportunity, with `person` and `note` missing even though person-based tools worked against the same workspace. The client now pages through the full Relay connection via `paging: { first, after }` until `pageInfo.hasNextPage` is false, collecting every object regardless of default page size or ordering. Unit coverage in `tests/metadata-orphaned.test.js`.
- **Unknown session IDs are now resurrected instead of rejected with 404.** Some MCP gateways never re-initialise their upstream session after a `404` + `-32000 "Session not found"` — they retry the dead session ID forever, which surfaces to the end client as the connector dying mid-conversation after idle eviction or a server restart. Since sessions are interchangeable for a given config (same API key, same toolset), the server now transparently revives an unknown session ID: it builds a fresh transport pinned to the presented ID, runs a synthetic in-process `initialize` handshake, and serves the request. An `initialize` request carrying a stale session header still mints a fresh session (the client chose to start over). If resurrection isn't possible (no resolvable API key, or SDK internals change shape), the previous 404 behaviour is preserved. Idle eviction now logs each evicted session ID for operational visibility. Integration coverage in `tests/session-resurrection.test.js`, wired into CI.

### Added
- **Configurable session timeout via `SESSION_TIMEOUT_MS` env var.** Default preserved at 30 minutes. Set higher (e.g. `7200000` for 2 hours) to mitigate gateway-side bugs that do not re-initialise upstream sessions on `-32000 Session not found`. Documented in README and `.env.example`. The resolved timeout is logged on startup for operational visibility.

### Fixed
- **`create_note` and `create_task` now produce valid `bodyV2` payloads.** Twenty completed its `body → bodyV2` migration on both Note and Task types. The fork was sending plain strings to `bodyV2` and querying the field as a scalar — both rejected by the API. Inputs are now serialised into the `RichTextCreateInput { blocknote, markdown }` shape Twenty expects, and read queries select `bodyV2 { blocknote markdown }`. Activity timeline displays continue to use the markdown form for previews.
- **Metadata tools restored.** `list_all_objects`, `get_object_schema`, and `get_field_metadata` now hit Twenty's `/metadata` endpoint via a separate GraphQL client and use the correct `ObjectFilter` filter type (was incorrectly `ObjectFilterInput` against `/graphql`). Resolves "Cannot query field 'objects'" errors.

### Removed
- **`create_comment` tool and `createComment` client method.** Twenty removed the `Comment` entity from its API entirely — `CommentCreateInput` no longer exists in the schema. The tool was non-functional. Callers should use `create_note` instead.
- **`authorId` parameter on `create_note`.** The field has been removed from Twenty's `Note` type.

### Documentation
- Added `docs/RICH_TEXT.md` covering the `bodyV2` contract, BlockNote JSON shape, and plain-text input semantics.
- README "Known issues" no longer lists the metadata-tools bug (fixed).
- TOOLS.md no longer documents the removed `create_comment` tool.

### Internal
- Stronger create-vs-read input typing: `createTask` and `createNote` now accept `TaskCreateInput` / `NoteCreateInput` rather than the read models.
- `RichTextInput.blocknote` and `RichTextInput.markdown` are required at the TypeScript level (the GraphQL contract permits both nullable, but the serializer always produces both — the type catches misuse at compile time).
- `serializeRichText` helper is exported for test access.
- BlockNote blocks now include unique `id` fields, matching the BlockNote v0.x document schema Twenty's frontend expects.

## [1.3.0] - 2026-01-12

### 🎉 Added
- **Docker MCP Support**: Now available on [Docker Hub MCP Registry](https://hub.docker.com/mcp)!
  - Install via Docker Desktop MCP Catalog
  - Or use `docker mcp install twenty-mcp`
  - Configuration files in `docker-mcp/` directory

### 🔒 Security
- Updated MCP SDK to latest version (security fixes)
- Fixed all npm audit vulnerabilities (was 7, now 0)
- Updated body-parser, js-yaml, qs, and tmp dependencies

### 📚 Documentation
- Added Docker MCP installation option to README
- Updated installation comparison table

### 🔧 Technical Improvements
- Repository unarchived and refreshed for continued maintenance

## [1.2.0] - 2025-06-24

### 🎉 Added
- **npx Support**: Try Twenty MCP Server instantly without installation!
  - Run `npx twenty-mcp-server setup` to get started immediately
  - No global installation required - perfect for evaluation
  - Configuration automatically persists between npx runs
  - Smart context detection for npx vs global installation
  
### 🚀 Features
- Execution context detection system (npx/global/local)
- Context-aware CLI messaging and headers
- npx-specific welcome messages and onboarding
- Performance tips for first-time npx users
- Clear migration path from npx to global installation
- Optimized package size (114.5 KB) for fast npx downloads

### 📚 Documentation
- README now prominently features npx as the quickest way to try
- Added npx examples throughout documentation
- IDE configuration notes for npx users
- Installation comparison table with npx option

### 🔧 Technical Improvements
- Created `src/cli/utils/execution-context.ts` for context detection
- Created `src/cli/utils/npx-helpers.ts` for npx-specific utilities
- Updated CLI entry point with context awareness
- Enhanced setup wizard with npx-specific guidance
- Smart postinstall script that detects execution context

### 🐛 Bug Fixes
- None in this release

### 💔 Breaking Changes
- None - full backward compatibility maintained

## [1.1.0] - Previous Release

- Initial OAuth 2.1 implementation
- IP address protection features
- Enhanced setup wizard
- Cross-platform compatibility improvements