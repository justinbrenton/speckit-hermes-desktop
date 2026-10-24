# Kanban API — Method Signatures (Spike 2 Verification)

Verified against Hermes Desktop SDK (`host.request('kanban.*')`).

## Create Card (TaskBoard writes to Kanban)
```typescript
host.request('kanban.create', {
  title: string,                // Task description from tasks.md
  column: 'Setup' | 'Foundational' | 'Feature' | 'Convergence' | 'Done',
  labels?: ['parallel', 'sequential', 'story-001'],
  story?: string,               // [US#] label value
  featureDir?: string,          // 'specs/001-user-auth/'
  taskId?: string               // Internal spec-kit task reference
}) -> { success: boolean, cardId: string, url?: string }
```

Status: Method signature verified from SDK docs. Actual execution requires Hermes Desktop runtime (planned for Spike 2).
