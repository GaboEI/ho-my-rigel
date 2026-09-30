---
name: github-public-writing
description: >-
  Write or audit public-facing GitHub repository content as clear, accurate,
  product-oriented documentation. Use when creating, editing, reviewing, or
  reorganizing README content, public docs, compatibility tables, installation
  or usage guides, examples, or repository metadata intended for external
  readers. Do not use for Obsidian vault notes, internal evidence, private
  operational documentation, code comments, commits, or non-public artifacts.
metadata:
  version: 1.0.0
---

# Public GitHub Writing

## Outcome

Make the public repository explain the product clearly to users, developers,
system engineers, collaborators, and evaluators. It must be concise,
professional, technically honest, and easy to scan.

Public documentation presents what the product offers and how to use it. It
does not expose the internal process used to validate or demonstrate it.

## Truth boundary

Every public claim must be supported by the project's authoritative public
source and completed evidence. Do not invent support, broaden compatibility,
or hide a limitation that changes a user's decision or expected behavior.

Do not publish internal validation process or private operational details:

* phases, task numbers, gates, or internal status labels;
* evidence paths, individual test results, or approval history;
* private hosts, profiles, credentials, or environment-specific identifiers;
* internal detection mechanisms, adapters, or architecture details that do
  not affect user setup or behavior.

Expose a technical detail when it materially changes installation,
configuration, compatibility, security, operation, or a real limitation.

## Writing standard

Write product-first content. Lead with capabilities, compatibility,
installation, configuration, usage, and real limitations. Prefer direct
sentences, familiar software terminology, concise tables, and navigation that
answers a reader's practical question quickly.

Use precise support language. Describe a capability as compatible or supported
only when the authoritative source permits that claim. Do not add qualifiers
such as `experimental`, `native`, `family-detected`, or validation jargon
unless the distinction has a real user-facing consequence.

Do not turn an internal implementation mechanism into a public feature merely
because it explains how compatibility was determined.

## Before finalizing

Check each changed public statement:

1. Is it true according to the authoritative source?
2. Does it help an external reader decide, install, configure, or use the
   product?
3. Does it preserve material limits and safety boundaries?
4. Does it avoid internal process, private details, and unsupported claims?

When writing, keep edits within the authorized scope. When auditing, report
specific public-writing defects and their evidence; do not change audited
artifacts unless separately authorized.

