#!/usr/bin/env python3
"""Portable Obsidian vault link-graph auditor.

Read-only. Never modifies the vault. Used by the obsidian-second-brain-audit
skill for the discovery/measurement phase, and can also be dropped into any
vault as its own standing verification tool (see the skill's "Leave a
verifier behind" step, which deploys a self-locating copy).

Usage:
  python3 audit_vault.py <vault_path>                  # full report
  python3 audit_vault.py <vault_path> --new <rel_path>  # single-note check
  python3 audit_vault.py <vault_path> --json            # machine-readable

Self-locating mode: if this file is deployed inside a vault at
<vault>/.tools/audit_vault.py (or audit_links.py) and invoked with NO path
argument, it auto-detects the vault as its own grandparent directory. This
is how the skill leaves a standing verifier behind in every audited vault.

Exit code is non-zero when at least one fully isolated note is found (full
report mode) or when the checked note is isolated (--new mode).
"""
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path


def collect_files(vault: Path):
    files = []
    for root, dirs, fnames in os.walk(vault):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in fnames:
            if f.endswith(".md"):
                files.append(str((Path(root) / f).relative_to(vault)))
    return files


def build_graph(vault: Path, files):
    by_base = defaultdict(list)
    for rel in files:
        by_base[Path(rel).stem].append(rel)

    def resolve(target):
        t = target.split("|")[0].split("#")[0].split("^")[0].strip()
        if not t:
            return None
        t = re.sub(r"\.md$", "", t)
        if t in by_base:
            return by_base[t][0]
        cand = vault / (t + ".md")
        return str(cand.relative_to(vault)) if cand.exists() else None

    outgoing = {}
    incoming = defaultdict(set)
    broken = defaultdict(list)
    for rel in files:
        content = (vault / rel).read_text(encoding="utf-8", errors="replace")
        outs = set()
        for m in re.finditer(r"\[\[([^\]]+)\]\]", content):
            r = resolve(m.group(1))
            if r:
                outs.add(r)
            else:
                broken[m.group(1).split("|")[0].strip()].append(rel)
        outgoing[rel] = outs
        for r in outs:
            incoming[r].add(rel)
    return outgoing, incoming, broken, by_base


def duplicate_basenames(by_base):
    return {b: rels for b, rels in by_base.items() if len(rels) > 1}


def connected_components(files, outgoing):
    adj = defaultdict(set)
    for rel, outs in outgoing.items():
        for o in outs:
            adj[rel].add(o)
            adj[o].add(rel)
    visited = set()
    comps = []
    for n in files:
        if n in visited:
            continue
        stack = [n]
        visited.add(n)
        comp = []
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for nb in adj[cur]:
                if nb not in visited:
                    visited.add(nb)
                    stack.append(nb)
        comps.append(comp)
    comps.sort(key=len, reverse=True)
    return comps


def report(vault, files, outgoing, incoming, broken, by_base, as_json=False):
    isolated = [r for r in files if not outgoing[r] and not incoming[r]]
    orphan = [r for r in files if not incoming[r]]
    dead_end = [r for r in files if not outgoing[r]]
    dups = duplicate_basenames(by_base)
    comps = connected_components(files, outgoing)
    n_broken = sum(len(v) for v in broken.values())

    data = {
        "vault": str(vault),
        "total_notes": len(files),
        "outgoing_links": sum(len(o) for o in outgoing.values()),
        "notes_with_outgoing": len([r for r in files if outgoing[r]]),
        "isolated": sorted(isolated),
        "orphan": sorted(orphan),
        "dead_end": sorted(dead_end),
        "duplicate_basenames": {k: v for k, v in dups.items()},
        "broken_links": {k: v for k, v in broken.items()},
        "connected_components": len(comps),
        "largest_component": len(comps[0]) if comps else 0,
        "single_note_components": len([c for c in comps if len(c) == 1]),
    }

    if as_json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return len(isolated)

    print(f"Vault: {vault}")
    print(f"Total notes: {data['total_notes']}")
    print(f"Outgoing links: {data['outgoing_links']}")
    print(f"Notes with >=1 outgoing link: {data['notes_with_outgoing']}/{data['total_notes']}")
    print(f"Fully isolated notes (no in, no out): {len(isolated)}")
    print(f"Orphan notes (no incoming): {len(orphan)}")
    print(f"Dead-end notes (no outgoing): {len(dead_end)}")
    print(f"Broken links (unresolved target): {n_broken} refs, {len(broken)} unique targets")
    print(f"Duplicate basenames (break wikilink resolution): {len(dups)}")
    print(f"Connected components: {len(comps)} | largest: {data['largest_component']} | single-note: {data['single_note_components']}")

    if isolated:
        print("\n[FAIL] Fully isolated notes:")
        for r in sorted(isolated):
            print(f"  - {r}")
    if dups:
        print("\n[WARN] Duplicate basenames:")
        for b, rels in dups.items():
            print(f"  '{b}': {rels}")
    if broken:
        print("\n[WARN] Broken link targets:")
        for t, refs in sorted(broken.items(), key=lambda kv: -len(kv[1]))[:25]:
            print(f"  [[{t}]] <- {len(refs)} note(s): {refs[:3]}")

    return len(isolated)


def check_single(vault, rel, outgoing, incoming):
    if rel not in outgoing:
        print(f"[ERROR] not found in vault: {rel}")
        return 1
    has_out = bool(outgoing[rel])
    has_in = bool(incoming[rel])
    print(f"File: {rel}")
    print(f"  Outgoing links: {'yes' if has_out else 'NO'} ({len(outgoing[rel])})")
    print(f"  Incoming links: {'yes' if has_in else 'NO'} ({len(incoming[rel])})")
    if not has_out and not has_in:
        print("  [FAIL] Isolated note — add its links section before continuing.")
        return 1
    if not has_out:
        print("  [WARN] No outgoing links: doesn't say where it came from or what it relates to.")
    if not has_in:
        print("  [WARN] No incoming links: nothing points to it; unreachable by navigation.")
    return 0


def main():
    raw = sys.argv[1:]
    skip_next = False
    args = []
    for a in raw:
        if skip_next:
            skip_next = False
            continue
        if a in ("--new",):
            skip_next = True
            continue
        if a.startswith("--"):
            continue
        args.append(a)
    if args:
        vault = Path(args[0]).resolve()
    elif Path(__file__).resolve().parent.name == ".tools":
        # self-locating mode: deployed as <vault>/.tools/audit_vault.py
        vault = Path(__file__).resolve().parent.parent
    else:
        print(__doc__)
        sys.exit(2)
    if not vault.is_dir():
        print(f"[ERROR] not a directory: {vault}")
        sys.exit(2)

    files = collect_files(vault)
    outgoing, incoming, broken, by_base = build_graph(vault, files)

    if "--new" in sys.argv:
        rel = sys.argv[sys.argv.index("--new") + 1]
        sys.exit(check_single(vault, rel, outgoing, incoming))

    as_json = "--json" in sys.argv
    n_isolated = report(vault, files, outgoing, incoming, broken, by_base, as_json=as_json)
    sys.exit(1 if n_isolated > 0 else 0)


if __name__ == "__main__":
    main()

