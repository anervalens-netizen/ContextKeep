# Batch 8 — opt-in byte-budgeted MCP search cards

Status: **source candidate / V-10 PARTIAL**

This source candidate is stacked on Batch 7, not the deployed runtime.
The original search_context request keeps its full output and accepted
versus unreviewed working trust separation.

## Contract

- representation=full remains the default. maxResultBytes is optional.
  When set and exceeded, the call fails with search_budget_exceeded.
  The default result is never clipped to falsely satisfy a budget.
- representation=cards uses a structured response of 2,048–32,768 bytes
  (default 12,000). It preserves record ID, project, type, subject, truth
  status, provenance, recorded/event/effective/review timestamps, freshness,
  task state and checkpoint task/next action. Long text is clipped to
  144 UTF-16 units. Evidence bodies are omitted with explicit flags and
  counts of retrieved items omitted by the card view.
- maxResultBytes measures actual UTF-8 JSON bytes in structuredContent,
  not SDK/provider tokens or an implementation-specific JSON-RPC envelope.
  The response declares the budget requested and actual bytes.
- The packer removes trailing results from separate canonical/working
  lists but keeps the first ranked hit from each originally nonempty
  trust scope. It reports missing trailing rows separately from the
  existing candidate-limit flags. An impossible protected core fails
  with search_budget_too_small, not a fake complete empty result.
- Each card declares detailTool=get_record and exact detailArgs. A working
  proposal requires includeUnreviewed=true, explicitly carried in
  its detail arguments. Card mode uses compact output and avoids a
  duplicate canonicalRecords array.
- Existing compact=true/full and old request defaults stay compatible.

## Evidence and open gates

Synthetic MCP integration tests cover accepted/proposed separation,
Unicode UTF-8 serialization, ordering, mandatory core, overflow errors,
working-only output, legacy responses and no business-state mutation.
The existing HTTP/MCP search scope/date and temporal tests are unchanged.
No private deployment observations appear in this public note.

This first iteration does not implement source_evidence cards, revision-
bound selected evidence pages (ME-12) or a common packing policy for
resume/work context (ME-11). get_record offers a normal detail read,
not a revision-pinned source snapshot. V-10 stays PARTIAL, and passing
these source tests does not authorize production installation.
