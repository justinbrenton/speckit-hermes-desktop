# Round-Trip Sync Prototype — Spike 2 Verification

Two-way file synchronization between interactive panes (`SpecBuilderPane.jsx`, `TaskBoardPane.jsx`) and `.specify/` markdown files (`spec.md`, `tasks.md`, `constitution.md`).

## Verification Criteria (Concrete)
1. User edits pane → `FileSystem.write()` fires → `.specify/` updated.
2. User edits `.specify/` in VS Code → `FS watch` event → `SpecParser.parse()` → pane refreshes.
3. `[NEEDS CLARIFICATION]` markers preserved across both directions.
4. Checklist state (`- [ ]` / `- [x]`) preserved in `tasks.md`.
5. Constitution wizard output (`.specify/memory/constitution.md`) preserved.
6. No data loss after concurrent edit scenario (pane edit + file edit within 5 seconds).

## Parser Implementation
```typescript
// remark/MDX AST approach (not regex)
import { remark } from 'remark';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';

const parser = remark().use(remarkParse).use(remarkStringify);
const ast = parser.parse(markdownContent);
// Surgical edit: find node by position/text match → edit → serialize
```

Status: Prototype spec defined. Parser stub exists (`SpecParser.ts`). Verification requires working plugin in Hermes Desktop runtime (planned for Spike 2).
