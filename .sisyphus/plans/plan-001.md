Prometheus-style Plan Skeleton - plan-001.md

## TODOs
- [ ] Create starter plan skeleton plan-001.md with granular subtasks
- [ ] Subtask 2: Create Notepad skeleton for plan-001 (learnings, decisions, issues, problems)
  - [ ] Subtask 2.1: Create .sisyphus/notepads/plan-001/learnings.md (already exists)
  - [ ] Subtask 2.2: Create .sisyphus/notepads/plan-001/decisions.md (already exists)
  - [ ] Subtask 2.3: Create .sisyphus/notepads/plan-001/issues.md (already exists)
  - [ ] Subtask 2.4: Create .sisyphus/notepads/plan-001/problems.md (already exists)
- [ ] Subtask 3: Initialize boulder.json skeleton for plan-001
  - [ ] Subtask 3.1: Ensure active_plan references plan file path
  - [ ] Subtask 3.2: Populate started_at with current timestamp
  - [ ] Subtask 3.3: Initialize session_ids to an empty array
  - [ ] Subtask 3.4: Save to .sisyphus/boulder.json
- [x] Create Notepad skeleton for plan-001 (learnings, decisions, issues, problems)
- [ ] Initialize boulder.json skeleton for plan-001
- [ ] Register initial top-level tasks and granular subtasks

> Each top-level task must be decomposed into concrete subtasks touching explicit files and functions, with clear verification steps.

## Final Verification Wave
- [ ] Phase 1: Read code changes
- [ ] Phase 2: Run automated checks (lint/tests/build)
- [ ] Phase 3: Hands-on QA (manual checks)
- [ ] Phase 4: Gate decision

## 1. TASK
- [ ] Create starter plan skeleton plan-001.md with granular sub-tasks
  - [ ] Subtask 1: Create the plan file .sisyphus/plans/plan-001.md and write a header
  - [ ] Subtask 2: Add top-level tasks (e.g., Initialize skeleton, Create notepads, Create boulder.json)
  - [ ] Subtask 3: For each top-level task, provide granular subtasks (touching specific files)
  - [ ] Subtask 4: Add a minimal example of a 6-section delegation prompt in a future delegation
  - [ ] Subtask 5: Create a section to track verification steps

## 2. EXPECTED OUTCOME
- [ ] Files created/modified: .sisyphus/plans/plan-001.md
- [ ] Functionality: A starter skeleton plan with granular subtasks and a bookkeeping template
- [ ] Verification: The plan file exists and contains decomposed subtasks

## 3. REQUIRED TOOLS
- [tool]: explore
- context7: Look up plan-template patterns
- ast-grep: search for markdown plan skeleton patterns

## 4. MUST DO
- Follow atlas 6-section delegation prompt structure in later delegations
- Append findings to notepad (plan-001)
- Include granular subtasks with explicit file references

## 5. MUST NOT DO
- Do NOT modify files outside .sisyphus/plans and .sisyphus/notepads
- Do NOT introduce external dependencies
- Do NOT skip verification

## 6. CONTEXT
### Notepad Paths
- READ: .sisyphus/notepads/plan-001/learnings.md
- WRITE: Append to appropriate notepad in .sisyphus/notepads/plan-001

### Inherited Wisdom
- Use detailed, explicit file paths for all subtasks
- Ensure traceability from each subtask to a verification step

### Dependencies
- None
