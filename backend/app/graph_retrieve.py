"""Hybrid retrieval: which meetings should answer this question?

Two deterministic scorers, no LLM call at question time:
- keyword_scores: token/bigram counting over each session's raw title +
  notes. Covers questions whose wording matches no extracted entity (the
  "hiring process" case the graph alone measurably failed).
- graph_scores: entity matching (full-name substring OR >= 2 name tokens
  present in the question) plus 1-hop edge traversal. Covers meetings
  about a subject they never name (the "Priya 1:1" relational-trap case
  keywords alone measurably failed).

Each score dict is normalized by its own max before summing, so neither
method swamps the other by raw scale. Both empty -> recency fallback.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List, Optional, Set

from .knowledge_graph import load_graph, normalize_name
from .sessions_store import load_action_items, load_sessions, load_transcript_segments

STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "do", "does", "did", "done", "what", "who", "whom", "when", "where",
    "why", "how", "which", "and", "or", "but", "of", "to", "in", "on",
    "at", "for", "with", "about", "it", "its", "this", "that", "these",
    "those", "tell", "me", "us", "we", "our", "your", "you", "i", "my",
    "s", "t", "any", "all", "there", "here", "have", "has", "had", "can",
    "could", "should", "would", "will", "get", "got", "going",
}

TITLE_WEIGHT = 3
BIGRAM_WEIGHT = 3


def tokenize(text: str) -> List[str]:
    out: List[str] = []
    word: List[str] = []
    for ch in text.lower():
        if ch.isalnum():
            word.append(ch)
        else:
            if word:
                out.append("".join(word))
                word = []
    if word:
        out.append("".join(word))
    return out


def _question_tokens(question: str) -> List[str]:
    return [t for t in tokenize(question) if t not in STOPWORDS and len(t) > 2]


def keyword_scores(question: str, records: List[dict]) -> Dict[str, float]:
    q_tokens = _question_tokens(question)
    bigrams = [f"{a} {b}" for a, b in zip(q_tokens, q_tokens[1:])]
    scores: Dict[str, float] = {}
    for record in records:
        notes_tokens = tokenize(record.get("notes") or "")
        title_tokens = tokenize(record.get("title") or "")
        notes_join = " ".join(notes_tokens)
        score = 0
        for t in q_tokens:
            score += notes_tokens.count(t) + TITLE_WEIGHT * title_tokens.count(t)
        for bg in bigrams:
            score += BIGRAM_WEIGHT * notes_join.count(bg)
        if score > 0:
            scores[record["id"]] = float(score)
    return scores


def _node_matches_question(q_lower: str, q_token_set: Set[str], name: str, aliases: List[str]) -> bool:
    """Full normalized name/alias as a substring of the question, OR (for
    multi-token names) at least 2 of the name's tokens present in the
    question -- the token-overlap rule added after exact-substring matching
    failed to connect a 'pricing page' question to a node named 'pricing
    page redesign' in the 2026-08-13 re-run.
    """
    for form in [name, *aliases]:
        nf = normalize_name(form)
        if not nf:
            continue
        if nf in q_lower:
            return True
        toks = nf.split()
        if len(toks) >= 2 and sum(1 for t in toks if t in q_token_set) >= 2:
            return True
    return False


def graph_scores(graph: dict, question: str) -> Dict[str, float]:
    q_lower = question.lower()
    q_token_set = set(tokenize(q_lower))
    nodes = graph.get("nodes", {})
    matched = {
        nid for nid, node in nodes.items()
        if _node_matches_question(q_lower, q_token_set, node.get("name", ""), node.get("aliases", []))
    }
    if not matched:
        return {}

    hits: Dict[str, float] = {}

    def bump(sid) -> None:
        if sid:
            hits[sid] = hits.get(sid, 0.0) + 1.0

    for nid in matched:
        for sid in nodes[nid].get("sessions", []):
            bump(sid)
    for edge in graph.get("edges", []):
        src, tgt = edge.get("source"), edge.get("target")
        if src in matched or tgt in matched:
            bump(edge.get("session_id"))
            other = tgt if src in matched else src
            for sid in nodes.get(other, {}).get("sessions", []):
                bump(sid)
    return hits


def find_relevant_sessions(store_dir: Path, question: str, max_sessions: int = 5) -> List[str]:
    records = [r for r in load_sessions(store_dir) if not r.get("trashed_at")]
    recency = [r["id"] for r in sorted(records, key=lambda r: r.get("created_at") or "", reverse=True)]

    kw = keyword_scores(question, records)
    live = set(recency)
    # The graph can hold ids for since-trashed/deleted sessions; retrieval
    # must never surface those.
    gr = {sid: s for sid, s in graph_scores(load_graph(store_dir), question).items() if sid in live}

    if not kw and not gr:
        return recency[:max_sessions]

    kw_max = max(kw.values()) if kw else 1.0
    gr_max = max(gr.values()) if gr else 1.0
    combined = {
        sid: kw.get(sid, 0.0) / kw_max + gr.get(sid, 0.0) / gr_max
        for sid in set(kw) | set(gr)
    }
    ranked = sorted(combined.items(), key=lambda kv: (-kv[1], recency.index(kv[0])))
    return [sid for sid, _ in ranked[:max_sessions]]


# Chars of surrounding context kept on each side of a snippet's matched
# substring -- enough to show what the meeting was about without dumping the
# whole notes/segment/action-item text into the sidebar.
SNIPPET_CONTEXT_CHARS = 40


def _first_token_match(text: str, q_tokens: List[str]) -> Optional["re.Match[str]"]:
    """Earliest whole-word (case-insensitive) match of any query token in
    text, or None. Whole-word, not substring, so a query for "cat" doesn't
    highlight the middle of "concatenate" -- consistent with tokenize()
    never producing "cat" as its own token from that word either.
    """
    best: Optional["re.Match[str]"] = None
    for t in q_tokens:
        m = re.search(r"\b" + re.escape(t) + r"\b", text, re.IGNORECASE)
        if m and (best is None or m.start() < best.start()):
            best = m
    return best


def _make_snippet(text: str, match: "re.Match[str]", source: str) -> dict:
    start = max(0, match.start() - SNIPPET_CONTEXT_CHARS)
    end = min(len(text), match.end() + SNIPPET_CONTEXT_CHARS)
    return {
        "source": source,
        "text": text[start:end],
        "match_start": match.start() - start,
        "match_end": match.end() - start,
    }


def search_sessions(store_dir: Path, query: str, max_results: int = 20) -> List[dict]:
    """Literal keyword search over each non-trashed session's title, notes,
    transcript, and action items -- for finding the meeting where something
    specific was said, not for synthesizing an answer (that's
    find_relevant_sessions/build_context, used by chat). A plain synchronous
    scan: no index, since a single user's archive is realistically hundreds
    of sessions at most (see docs/Individual Workflow Features
    fix/01-fulltext-search.md).
    """
    q_tokens = _question_tokens(query)
    if not q_tokens:
        return []

    scored: List[tuple] = []
    for record in load_sessions(store_dir):
        if record.get("trashed_at"):
            continue
        session_id = record["id"]
        session_dir = store_dir / session_id
        title = record.get("title") or "Untitled meeting"
        notes = record.get("notes") or ""
        segments = load_transcript_segments(session_dir)
        action_items = load_action_items(session_dir) or []

        title_tokens = tokenize(title)
        notes_tokens = tokenize(notes)
        transcript_text = " ".join(seg.get("text") or "" for seg in segments)
        transcript_tokens = tokenize(transcript_text)
        action_text = " ".join(item.get("text") or "" for item in action_items)
        action_tokens = tokenize(action_text)

        score = 0
        for t in q_tokens:
            score += (
                TITLE_WEIGHT * title_tokens.count(t)
                + notes_tokens.count(t)
                + transcript_tokens.count(t)
                + action_tokens.count(t)
            )
        if score <= 0:
            continue

        snippets: List[dict] = []
        notes_match = _first_token_match(notes, q_tokens)
        if notes_match:
            snippets.append(_make_snippet(notes, notes_match, "notes"))
        for seg in segments:
            seg_text = seg.get("text") or ""
            seg_match = _first_token_match(seg_text, q_tokens)
            if seg_match:
                snippets.append(_make_snippet(seg_text, seg_match, "transcript"))
                break
        for item in action_items:
            item_text = item.get("text") or ""
            item_match = _first_token_match(item_text, q_tokens)
            if item_match:
                snippets.append(_make_snippet(item_text, item_match, "action_items"))
                break

        scored.append((score, {
            "session_id": session_id,
            "title": title,
            "created_at": record.get("created_at") or "",
            "snippets": snippets[:2],
        }))

    scored.sort(key=lambda pair: -pair[0])
    return [result for _, result in scored[:max_results]]


def build_context(store_dir: Path, session_ids: List[str]) -> str:
    by_id = {r["id"]: r for r in load_sessions(store_dir) if not r.get("trashed_at")}
    blocks: List[str] = []
    for sid in session_ids:
        record = by_id.get(sid)
        if record is None:
            continue
        title = record.get("title") or "Untitled meeting"
        date = (record.get("created_at") or "")[:10]
        blocks.append(f"=== Meeting: {title} ({date}) ===\n{record.get('notes') or ''}")
    return "\n\n".join(blocks)
