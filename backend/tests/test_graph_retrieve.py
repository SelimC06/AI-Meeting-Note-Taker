import json

from app import graph_retrieve


def _write_index(tmp_path, records):
    (tmp_path / "sessions_index.json").write_text(json.dumps(records), encoding="utf-8")


def _record(sid, title, notes, created_at, trashed_at=None):
    return {
        "id": sid, "title": title, "notes": notes, "created_at": created_at,
        "video_path": "", "trashed_at": trashed_at, "status": "done",
    }


# Fixture data encodes the two 2026-08 head-to-head regression cases:
# - m4 ("Hiring Standup") is findable ONLY by keywords (no graph node
#   matches "hiring").
# - m5 ("Priya 1:1") is about the pricing work but never says "pricing" or
#   "page" -- findable ONLY through the graph via Priya's edge.
RECORDS = [
    _record("m1", "Pricing Page Kickoff", "Sarah Klein will lead the pricing page redesign. Launch target August 15th.", "2026-07-01T10:00:00+00:00"),
    _record("m3", "Pricing Launch Slip Discussion", "The pricing page launch is pushed to September 1st.", "2026-07-22T10:00:00+00:00"),
    _record("m4", "Hiring Standup", "Jordan gave an update on the open backend engineer role. Onsite interviews next week.", "2026-07-25T10:00:00+00:00"),
    _record("m5", "Priya 1:1", "Priya walked through the remaining billing service work for the redesign. September 1st holds.", "2026-07-28T10:00:00+00:00"),
]

GRAPH = {
    "nodes": {
        "project:pricing-page-redesign": {
            "id": "project:pricing-page-redesign", "type": "project",
            "name": "pricing page redesign", "aliases": [], "sessions": ["m1", "m3"],
        },
        "person:priya": {
            "id": "person:priya", "type": "person",
            "name": "Priya", "aliases": [], "sessions": ["m5"],
        },
        "project:september-1st-date": {
            "id": "project:september-1st-date", "type": "project",
            "name": "September 1st date", "aliases": [], "sessions": ["m5"],
        },
    },
    "edges": [
        {"source": "person:priya", "relation": "works on", "target": "project:pricing-page-redesign",
         "session_id": "m3", "created_at": "2026-07-22T11:00:00+00:00"},
    ],
    "indexed_sessions": ["m1", "m3", "m5"],
}


def test_tokenize_splits_on_non_alphanumerics_and_lowercases():
    assert graph_retrieve.tokenize("Pricing-Page launch, Sept 1st!") == ["pricing", "page", "launch", "sept", "1st"]


def test_keyword_scores_counts_tokens_weights_title_and_bigrams():
    scores = graph_retrieve.keyword_scores("pricing page launch", RECORDS)
    # m1: notes have pricing(1)+page(1)+launch(1)=3, title has pricing+page=2*3=6,
    # bigram "pricing page" appears once in notes = 3. Total 12.
    assert scores["m1"] == 12.0
    assert "m5" not in scores          # no query token appears in m5
    assert scores["m3"] > 0


def test_keyword_scores_drops_stopwords_and_short_tokens():
    # Every token is a stopword or <= 2 chars -> no scores at all.
    assert graph_retrieve.keyword_scores("what did we do in it", RECORDS) == {}


def test_graph_scores_token_overlap_matches_longer_node_names():
    scores = graph_retrieve.graph_scores(GRAPH, "what's the latest status of the pricing page?")
    # "pricing page redesign" is not a substring of the question, but 2 of
    # its 3 tokens are present -> matched. Node sessions m1,m3 hit; its edge
    # (m3) hits; Priya on the edge's other end contributes m5 (1-hop).
    assert scores["m5"] >= 1.0
    assert scores["m1"] >= 1.0
    assert scores["m3"] >= 2.0


def test_graph_scores_single_shared_token_is_not_a_match():
    # Only "date" is shared with "September 1st date" (< 2 tokens) and no
    # other node matches -> no graph hits at all.
    assert graph_retrieve.graph_scores(GRAPH, "what is the launch date") == {}


def test_find_relevant_sessions_keyword_only_case(tmp_path):
    # The 2026-08-09 graph-blind regression: no node matches "hiring", but
    # keywords find exactly the right meeting.
    _write_index(tmp_path, RECORDS)
    (tmp_path / "knowledge_graph.json").write_text(json.dumps(GRAPH), encoding="utf-8")
    result = graph_retrieve.find_relevant_sessions(tmp_path, "tell me about the hiring process")
    assert result == ["m4"]


def test_find_relevant_sessions_graph_only_relational_trap(tmp_path):
    # The 2026-08-13 relational-trap regression: m5 never says "pricing" or
    # "page" but must be retrieved through Priya's edge.
    _write_index(tmp_path, RECORDS)
    (tmp_path / "knowledge_graph.json").write_text(json.dumps(GRAPH), encoding="utf-8")
    result = graph_retrieve.find_relevant_sessions(tmp_path, "what's the latest status of the pricing page?")
    assert "m5" in result
    assert "m4" not in result or result.index("m4") > result.index("m1")


def test_find_relevant_sessions_normalizes_so_neither_method_swamps(tmp_path):
    # A huge keyword score and a small graph score both normalize to 1.0
    # for their respective top sessions -- both must rank.
    _write_index(tmp_path, RECORDS)
    (tmp_path / "knowledge_graph.json").write_text(json.dumps(GRAPH), encoding="utf-8")
    result = graph_retrieve.find_relevant_sessions(tmp_path, "pricing page status")
    assert "m1" in result and "m5" in result


def test_find_relevant_sessions_falls_back_to_recency(tmp_path):
    _write_index(tmp_path, RECORDS)
    (tmp_path / "knowledge_graph.json").write_text(json.dumps(GRAPH), encoding="utf-8")
    result = graph_retrieve.find_relevant_sessions(tmp_path, "zzz qqq xxyzzy nothing")
    assert result == ["m5", "m4", "m3", "m1"]  # newest first


def test_find_relevant_sessions_respects_max_sessions(tmp_path):
    _write_index(tmp_path, RECORDS)
    (tmp_path / "knowledge_graph.json").write_text(json.dumps(GRAPH), encoding="utf-8")
    result = graph_retrieve.find_relevant_sessions(tmp_path, "zzz qqq xxyzzy nothing", max_sessions=2)
    assert result == ["m5", "m4"]


def test_find_relevant_sessions_excludes_trashed(tmp_path):
    records = RECORDS + [_record("m9", "Trashed Pricing Meeting", "pricing page pricing page", "2026-07-30T10:00:00+00:00", trashed_at="2026-08-01T10:00:00+00:00")]
    _write_index(tmp_path, records)
    (tmp_path / "knowledge_graph.json").write_text(json.dumps(GRAPH), encoding="utf-8")
    result = graph_retrieve.find_relevant_sessions(tmp_path, "pricing page")
    assert "m9" not in result


def test_find_relevant_sessions_excludes_graph_only_trashed_ids(tmp_path):
    # m9 is trashed but the graph still holds it in a matching node's
    # sessions -- the graph side alone must not resurface it.
    records = RECORDS + [_record("m9", "Old Pricing Sync", "pricing page pricing page", "2026-07-30T10:00:00+00:00", trashed_at="2026-08-01T10:00:00+00:00")]
    _write_index(tmp_path, records)
    graph = json.loads(json.dumps(GRAPH))
    graph["nodes"]["project:pricing-page-redesign"]["sessions"].append("m9")
    graph["edges"].append({"source": "person:priya", "relation": "works on", "target": "project:pricing-page-redesign", "session_id": "m9", "created_at": "2026-07-30T11:00:00+00:00"})
    (tmp_path / "knowledge_graph.json").write_text(json.dumps(graph), encoding="utf-8")
    result = graph_retrieve.find_relevant_sessions(tmp_path, "what's the latest status of the pricing page?")
    assert "m9" not in result


def test_build_context_formats_labeled_blocks_and_skips_trashed(tmp_path):
    records = RECORDS + [_record("m9", "Trashed", "gone", "2026-07-30T10:00:00+00:00", trashed_at="2026-08-01T10:00:00+00:00")]
    _write_index(tmp_path, records)
    context = graph_retrieve.build_context(tmp_path, ["m1", "m9", "m5"])
    assert "=== Meeting: Pricing Page Kickoff (2026-07-01) ===" in context
    assert "=== Meeting: Priya 1:1 (2026-07-28) ===" in context
    assert "Sarah Klein will lead" in context
    assert "Trashed" not in context


def test_build_context_empty_ids_returns_empty_string(tmp_path):
    _write_index(tmp_path, RECORDS)
    assert graph_retrieve.build_context(tmp_path, []) == ""
