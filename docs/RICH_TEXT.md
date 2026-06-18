# Rich text and `bodyV2`

Reference for how this fork serialises note and task bodies for Twenty CRM.

## Background

Twenty migrated its `Note` and `Task` types from a plain `body: String` field to a structured `bodyV2: RichText` field. The migration is complete on both types — querying `body` produces a schema error, and writing a plain string to `bodyV2` is rejected.

Verified via GraphQL introspection against `https://api.twenty.com/graphql` (2026-05):

| Type | Field | GraphQL type |
|------|-------|--------------|
| `NoteCreateInput.bodyV2` | input | `RichTextCreateInput` |
| `TaskCreateInput.bodyV2` | input | `RichTextCreateInput` |
| `NoteUpdateInput.bodyV2` | input | `RichTextUpdateInput` |
| `TaskUpdateInput.bodyV2` | input | `RichTextUpdateInput` |
| `Note.bodyV2` | output | `RichText` |
| `Task.bodyV2` | output | `RichText` |

All four `RichText*` types share the same shape:

```graphql
type RichText {
  blocknote: String
  markdown: String
}

input RichTextCreateInput {
  blocknote: String
  markdown: String
}
```

Both fields are nullable strings at the GraphQL level. In practice Twenty's UI expects both to be populated when `bodyV2` is provided.

## What `blocknote` actually contains

`blocknote` is a stringified BlockNote document — a JSON array of block objects. BlockNote is the rich-text editor Twenty's frontend uses (see https://www.blocknotejs.org). Each block has an `id`, a `type`, `props`, `content`, and `children`.

Minimal valid document for a one-paragraph note containing the text `"hello world"`:

```json
[
  {
    "id": "abc1234567",
    "type": "paragraph",
    "props": {
      "textColor": "default",
      "backgroundColor": "default",
      "textAlignment": "left"
    },
    "content": [
      { "type": "text", "text": "hello world", "styles": {} }
    ],
    "children": []
  }
]
```

The `id` field is required by BlockNote v0.x for editor reconciliation. Documents without `id` fields render but cannot be edited cleanly.

## What `markdown` contains

A plain UTF-8 string equivalent of the document. Used as a fallback when `blocknote` cannot be rendered (search indexing, plain-text export, headless previews).

## How this fork serialises input

`serializeRichText(plain: string)` in `src/client/twenty-client.ts`:

1. Splits input on blank lines (`\n\n+`) into paragraphs.
2. Wraps each paragraph in a BlockNote `paragraph` block with a generated 10-character lowercase alphanumeric `id`, default props, and a single `text` content node with empty `styles: {}`.
3. Stringifies the block array into `blocknote`.
4. Stores the original input verbatim as `markdown`.

```ts
serializeRichText("hello\n\nworld")
// →
// {
//   blocknote: '[{"id":"abc1234567","type":"paragraph",...,"content":[{"type":"text","text":"hello","styles":{}}]},{"id":"def8901234","type":"paragraph",...,"content":[{"type":"text","text":"world","styles":{}}]}]',
//   markdown:  "hello\n\nworld"
// }
```

## Plain-text contract

The MCP tool inputs (`body` on `create_note` and `create_task`) accept plain text only. **Markdown formatting is not parsed.**

If the caller passes `"This is **bold**"`:

- `markdown` field: `"This is **bold**"` — preserved verbatim
- `blocknote` field: a paragraph block whose `text` is the literal string `"This is **bold**"`, including the asterisks
- Twenty's UI: renders the text as `This is **bold**` with no bold styling

This is intentional. Parsing markdown into BlockNote inline marks (`bold: true`, `italic: true`, link nodes, etc.) is a substantial body of code and not within the scope of this serialiser. Callers wanting formatted output should construct a BlockNote document directly and pass it through a future `body_blocknote` parameter (not yet implemented).

## How this fork queries output

Read queries on Note, Task, and the activities timeline select both subfields:

```graphql
{
  notes(first: 20) {
    edges {
      node {
        id
        title
        bodyV2 { blocknote markdown }
        createdAt
      }
    }
  }
}
```

The activities timeline flattens `bodyV2.markdown` into the legacy `Activity.body: string` field for downstream display code, so timeline previews continue to show readable text without depending on BlockNote parsing.

## What was removed

- `Comment` entity — Twenty deleted it from the schema. `CommentCreateInput` introspects to `null`, no `Comment*` types exist. The fork's `create_comment` tool, `createComment` client method, and `Comment*` TypeScript types were removed in the same change that fixed `bodyV2`. Callers should use `create_note` instead.
- `authorId` on `create_note` input — field is no longer on Twenty's `Note` type.

## When to update this doc

- If Twenty changes the `RichText*` schema shape (run `__type(name:"RichTextCreateInput")` introspection to verify)
- If BlockNote releases a major version with a different document format
- If a future change adds proper markdown-to-BlockNote parsing (the plain-text contract section needs revising)
- If `Comment` or any equivalent entity is reintroduced to Twenty's schema
