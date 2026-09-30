"""Persistent knowledge graph built incrementally from meeting notes.

Mirrors sessions_store.py's conventions: single JSON file in the store
dir, atomic temp-file+os.replace writes, a module-level lock around every
read-modify-write, and missing/corrupt files folded into an empty shape.

Matching rules (all validated against real local-model extractions during
prototyping -- see the lean v2 design doc):
- Fuzzy name matching: exact after normalization, OR all of the shorter
  name's tokens contained in the longer's ("Marcus" ~ "Marcus Lee"), OR
  SequenceMatcher ratio >= 0.82 (close spellings).
- Merge classes: 'project' and 'topic' merge with each other -- the model
  assigns those two labels near-arbitrarily to the same real-world subject
  across meetings, which fragmented the central entity in testing. Every
  other type only merges within itself.
- First-name ambiguity guard: a bare single-token person name is never
  merged when two or more known multi-token person names start with that
  token ("Marcus" with both "Marcus Lee" and "Marcus Chen" present).
  Over-merging two real people creates confident false cross-links nothing
  downstream can catch (verification runs per-meeting, before merge);
  under-merging just costs a little recall, which hybrid retrieval covers.
"""
from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import List

from .corrupt_files import preserve_corrupt_copy

KNOWLEDGE_GRAPH_FILENAME = "knowledge_graph.json"

ALLOWED_TYPES = {"person", "project", "decision", "action_item", "topic", "organization"}

_MERGE_CLASS = {"project": "subject", "topic": "subject"}

FUZZY_RATIO_THRESHOLD = 0.82

# RLock for the same reason as sessions_store._APPEND_LOCK: writers hold it
# across their whole read-modify-write and call load_graph() inside it.
_GRAPH_LOCK = threading.RLock()

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def merge_class(etype: str) -> str:
    return _MERGE_CLASS.get(etype, etype)


def normalize_name(name: str) -> str:
    return " ".join(name.strip().lower().split())


def make_node_id(etype: str, name: str) -> str:
    slug = _SLUG_RE.sub("-", normalize_name(name)).strip("-") or "unnamed"
    return f"{etype}:{slug}"


def is_match(a: str, b: str) -> bool:
    a, b = normalize_name(a), normalize_name(b)
    if not a or not b:
        return False
    if a == b:
        return True
    a_tokens, b_tokens = a.split(), b.split()
    shorter, longer = (a_tokens, b_tokens) if len(a_tokens) <= len(b_tokens) else (b_tokens, a_tokens)
    if shorter and all(tok in longer for tok in shorter):
        return True
    return SequenceMatcher(None, a, b).ratio() >= FUZZY_RATIO_THRESHOLD


def empty_graph() -> dict:
    return {"nodes": {}, "edges": [], "indexed_sessions": []}


# How many times a session whose extraction came back unusable (not valid
# JSON / not the schema) is retried before backfill stops re-queueing it.
# Every launch used to retry every such session again -- on a custom
# provider that's two paid calls per session per launch, re-sending the
# notes each time, for extractions that were never going to parse.
MAX_EXTRACTION_ATTEMPTS = 3


def extraction_failures(graph: dict) -> dict:
    """session_id -> failed attempts so far. Optional key: graphs written
    before it existed simply have none."""
    failures = graph.get("extraction_failures")
    return failures if isinstance(failures, dict) else {}


def extraction_gave_up(graph: dict, session_id: str) -> bool:
    return extraction_failures(graph).get(session_id, 0) >= MAX_EXTRACTION_ATTEMPTS


def record_extraction_failure(store_dir: Path, session_id: str) -> int:
    """Count one failed extraction for session_id; returns the new count."""
    with _GRAPH_LOCK:
        graph = load_graph(store_dir)
        failures = dict(extraction_failures(graph))
        failures[session_id] = failures.get(session_id, 0) + 1
        graph["extraction_failures"] = failures
        _write_graph_atomic(store_dir, graph)
        return failures[session_id]


def _graph_path(store_dir: Path) -> Path:
    return store_dir / KNOWLEDGE_GRAPH_FILENAME


def load_graph(store_dir: Path) -> dict:
    """Read the graph file. Missing, unreadable, corrupt, or wrong-shaped
    file -> empty graph shape.

    Unlike the sessions index, a corrupt graph is safe to treat as empty:
    it's derived data -- every session missing from indexed_sessions gets
    re-queued by graph_jobs.backfill_unindexed and re-extracted from its
    notes. It's still copied aside first (once per corrupt version, see
    corrupt_files.preserve_corrupt_copy), because the next merge_extraction
    overwrites it and re-extraction with a local model isn't guaranteed to
    reproduce the same graph.
    """
    path = _graph_path(store_dir)
    if not path.exists():
        return empty_graph()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        data = None
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("nodes"), dict)
        or not isinstance(data.get("edges"), list)
        or not isinstance(data.get("indexed_sessions"), list)
    ):
        preserve_corrupt_copy(path)
        return empty_graph()
    return data


def _write_graph_atomic(store_dir: Path, graph: dict) -> None:
    """Same temp-file + fsync + os.replace pattern as
    sessions_store._write_sessions_atomic. Callers must hold _GRAPH_LOCK.
    """
    final_path = _graph_path(store_dir)
    tmp_path = final_path.with_suffix(final_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(graph, ensure_ascii=False, indent=2))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, final_path)


def _person_merge_is_ambiguous(new_forms: List[str], nodes: dict) -> bool:
    """True when any bare single-token form among new_forms is the first
    token of two or more existing multi-token person names.
    """
    first_tokens: List[str] = []
    for node in nodes.values():
        if node.get("type") != "person":
            continue
        toks = normalize_name(node.get("name", "")).split()
        if len(toks) > 1:
            first_tokens.append(toks[0])
    for form in new_forms:
        toks = normalize_name(form).split()
        if len(toks) == 1 and toks and first_tokens.count(toks[0]) >= 2:
            return True
    return False


def merge_extraction(store_dir: Path, session_id: str, extraction: dict) -> None:
    """Merge one meeting's (already verified) extraction into the graph.

    `extraction` is the plain-dict shape produced by
    graph_extract.Extraction.model_dump(). Under _GRAPH_LOCK for the whole
    read-modify-write. No-op if session_id is already indexed.
    """
    with _GRAPH_LOCK:
        graph = load_graph(store_dir)
        if session_id in graph["indexed_sessions"]:
            return
        nodes = graph["nodes"]
        local_to_node: dict = {}

        for ent in extraction.get("entities", []):
            if not isinstance(ent, dict):
                continue
            local_id = ent.get("id")
            etype = ent.get("type")
            name = (ent.get("name") or "").strip()
            if local_id is None or etype not in ALLOWED_TYPES or not name:
                continue
            aliases = [a.strip() for a in ent.get("aliases", []) if isinstance(a, str) and a.strip()]
            new_forms = [name] + aliases
            klass = merge_class(etype)

            matched_id = None
            if not (etype == "person" and _person_merge_is_ambiguous(new_forms, nodes)):
                for nid, node in nodes.items():
                    if merge_class(node["type"]) != klass:
                        continue
                    node_forms = [node["name"]] + list(node.get("aliases", []))
                    if any(is_match(f1, f2) for f1 in new_forms for f2 in node_forms):
                        matched_id = nid
                        break

            if matched_id is not None:
                node = nodes[matched_id]
                merged_aliases = set(node.get("aliases", [])) | set(aliases)
                if len(name) > len(node["name"]):
                    merged_aliases.add(node["name"])
                    node["name"] = name
                elif normalize_name(name) != normalize_name(node["name"]):
                    merged_aliases.add(name)
                node["aliases"] = sorted(merged_aliases)
                if session_id not in node["sessions"]:
                    node["sessions"].append(session_id)
                local_to_node[local_id] = matched_id
            else:
                base_id = make_node_id(etype, name)
                node_id = base_id
                suffix = 2
                while node_id in nodes:
                    node_id = f"{base_id}-{suffix}"
                    suffix += 1
                nodes[node_id] = {
                    "id": node_id,
                    "type": etype,
                    "name": name,
                    "aliases": sorted(set(aliases)),
                    "sessions": [session_id],
                }
                local_to_node[local_id] = node_id

        created_at = datetime.now(timezone.utc).isoformat()
        for rel in extraction.get("relations", []):
            if not isinstance(rel, dict):
                continue
            src = local_to_node.get(rel.get("source_id"))
            tgt = local_to_node.get(rel.get("target_id"))
            relation = (rel.get("relation") or "").strip()
            if src is None or tgt is None or not relation:
                continue
            graph["edges"].append({
                "source": src,
                "relation": relation,
                "target": tgt,
                "session_id": session_id,
                "created_at": created_at,
            })

        graph["indexed_sessions"].append(session_id)
        # Indexed now (possibly with nothing in it -- an empty extraction is
        # a real answer): drop any earlier failure count.
        if session_id in extraction_failures(graph):
            graph["extraction_failures"] = {
                k: v for k, v in extraction_failures(graph).items() if k != session_id
            }
        _write_graph_atomic(store_dir, graph)


def remove_session(store_dir: Path, session_id: str) -> bool:
    """Strip everything a (permanently deleted) session contributed: its
    edges, its id from every node's sessions list, any node left with no
    sessions at all, edges touching those nodes, and its indexed_sessions
    entry. Returns False (no write) if the graph held nothing for it.

    A node shared with other meetings is kept -- those meetings still
    reference it -- even though its name/aliases may partly have come from
    this one; aliases aren't tracked per session, so they can't be
    attributed back.

    graph_jobs.index_session re-checks that the session still exists while
    holding _GRAPH_LOCK before merging, so an extraction already in flight
    when the session is deleted can't write it back after this runs.
    """
    with _GRAPH_LOCK:
        graph = load_graph(store_dir)
        changed = session_id in graph["indexed_sessions"] or session_id in extraction_failures(graph)
        if session_id in extraction_failures(graph):
            graph["extraction_failures"] = {
                k: v for k, v in extraction_failures(graph).items() if k != session_id
            }
        graph["indexed_sessions"] = [s for s in graph["indexed_sessions"] if s != session_id]

        removed_nodes = set()
        for nid, node in list(graph["nodes"].items()):
            sessions = node.get("sessions", [])
            if session_id not in sessions:
                continue
            changed = True
            remaining = [s for s in sessions if s != session_id]
            if remaining:
                node["sessions"] = remaining
            else:
                del graph["nodes"][nid]
                removed_nodes.add(nid)

        kept_edges = [
            e for e in graph["edges"]
            if e.get("session_id") != session_id
            and e.get("source") not in removed_nodes
            and e.get("target") not in removed_nodes
        ]
        if len(kept_edges) != len(graph["edges"]):
            changed = True
        graph["edges"] = kept_edges

        if changed:
            _write_graph_atomic(store_dir, graph)
        return changed
