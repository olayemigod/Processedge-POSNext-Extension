# ProcessEdge POSNext Extension Repository Instructions

## Mandatory canonical skill
Before planning, editing, implementing, reviewing, testing, creating a branch/PR, performing QA, migration, release, or any other repository operation, load and follow:

https://github.com/olayemigod/processedge-qa/blob/main/skills/processedge-frappe-product-engineering/SKILL.md

Re-read it at the start of each new work session and whenever the task changes materially.

## Pre-work gate
Check the canonical skill, repository docs, deployed/upstream POSNext compatibility, authoritative base, outstanding PRs, ERPNext/POS behavior, existing EdgeSuite/shared implementation, permission personas/tests and the smallest bounded mergeable slice before modifying code.

## Extension boundary
Prefer extension/override hooks over modifying upstream POSNext or ERPNext core. Preserve ERPNext Sales Invoice/payment/stock truth and POS lifecycle. Shared ProcessEdge UI behavior belongs in EdgeSuite UI when product-neutral. Repository-specific rules extend, but do not silently weaken, the canonical skill.
