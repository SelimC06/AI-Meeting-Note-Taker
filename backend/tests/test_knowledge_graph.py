import json
import threading

import pytest

from app import knowledge_graph


# ---------- matching primitives ----------

def test_normalize_name_lowercases_and_collapses_whitespace():
    assert knowledge_graph.normalize_name("  Sarah   KLEIN ") == "sarah klein"


def test_make_node_id_slugifies_type_and_name():
    assert knowledge_graph.make_node_id("person", "Sarah Klein") == "person:sarah-klein"
    assert knowledge_graph.make_node_id("project", "  Pricing  Page!! ") == "project:pricing-page"


def test_is_match_exact_after_normalization():
    assert knowledge_graph.is_match("Sarah Klein", "sarah   klein")


def test_is_match_token_containment_both_orders():
    assert knowledge_graph.is_match("Marcus", "Marcus Lee")
    assert knowledge_graph.is_match("Marcus Lee", "Marcus")


def test_is_match_close_spelling_via_ratio():
    assert knowledge_graph.is_match("Jon Smith", "John Smith")


def test_is_match_rejects_distinct_names():
    assert not knowledge_graph.is_match("Marcus", "Jordan")
    assert not knowledge_graph.is_match("pricing page", "billing service")
    assert not knowledge_graph.is_match("", "Marcus")


def test_merge_class_unifies_project_and_topic_only():
    assert knowledge_graph.merge_class("project") == knowledge_graph.merge_class("topic")
    assert knowledge_graph.merge_class("person") == "person"
    assert knowledge_graph.merge_class("person") != knowledge_graph.merge_class("project")
    assert knowledge_graph.merge_class("decision") != knowledge_graph.merge_class("action_item")


def test_empty_graph_shape():
    assert knowledge_graph.empty_graph() == {"nodes": {}, "edges": [], "indexed_sessions": []}


# ---------- storage + merge_extraction ----------

def _ext(entities, relations=None):
    return {"entities": entities, "relations": relations or []}


def _person(local_id, name, aliases=None):
    return {"id": local_id, "type": "person", "name": name, "aliases": aliases or []}


def test_load_graph_missing_file_returns_empty_shape(tmp_path):
    assert knowledge_graph.load_graph(tmp_path) == knowledge_graph.empty_graph()


def test_load_graph_corrupt_file_returns_empty_shape(tmp_path):
    (tmp_path / "knowledge_graph.json").write_text("{not json!!", encoding="utf-8")
    assert knowledge_graph.load_graph(tmp_path) == knowledge_graph.empty_graph()


def test_load_graph_wrong_shape_returns_empty_shape(tmp_path):
    (tmp_path / "knowledge_graph.json").write_text(json.dumps([1, 2, 3]), encoding="utf-8")
    assert knowledge_graph.load_graph(tmp_path) == knowledge_graph.empty_graph()


def test_load_graph_preserves_a_corrupt_file_once(tmp_path):
    (tmp_path / "knowledge_graph.json").write_text("{not json!!", encoding="utf-8")

    for _ in range(3):
        knowledge_graph.load_graph(tmp_path)

    preserved = list(tmp_path.glob("knowledge_graph.corrupt-*.json"))
    assert len(preserved) == 1
    assert preserved[0].read_text(encoding="utf-8") == "{not json!!"


def test_load_graph_preserves_a_wrong_shaped_file(tmp_path):
    (tmp_path / "knowledge_graph.json").write_text(json.dumps([1, 2, 3]), encoding="utf-8")
    knowledge_graph.load_graph(tmp_path)
    assert len(list(tmp_path.glob("knowledge_graph.corrupt-*.json"))) == 1


def test_merge_over_a_corrupt_graph_keeps_the_preserved_copy(tmp_path):
    (tmp_path / "knowledge_graph.json").write_text("{not json!!", encoding="utf-8")

    knowledge_graph.merge_extraction(tmp_path, "s1", _ext([_person(1, "Sarah Klein")]))

    assert knowledge_graph.load_graph(tmp_path)["indexed_sessions"] == ["s1"]
    preserved = list(tmp_path.glob("knowledge_graph.corrupt-*.json"))
    assert [p.read_text(encoding="utf-8") for p in preserved] == ["{not json!!"]


def test_load_graph_missing_file_creates_no_corrupt_copy(tmp_path):
    knowledge_graph.load_graph(tmp_path)
    assert list(tmp_path.glob("knowledge_graph.corrupt-*")) == []


def test_merge_creates_nodes_edges_and_marks_session_indexed(tmp_path):
    extraction = _ext(
        [_person(0, "Sarah Klein"), {"id": 1, "type": "project", "name": "pricing page", "aliases": []}],
        [{"source_id": 0, "relation": "owns", "target_id": 1}],
    )
    knowledge_graph.merge_extraction(tmp_path, "s1", extraction)
    graph = knowledge_graph.load_graph(tmp_path)
    assert graph["indexed_sessions"] == ["s1"]
    assert set(graph["nodes"]) == {"person:sarah-klein", "project:pricing-page"}
    assert graph["nodes"]["person:sarah-klein"]["sessions"] == ["s1"]
    (edge,) = graph["edges"]
    assert edge["source"] == "person:sarah-klein"
    assert edge["relation"] == "owns"
    assert edge["target"] == "project:pricing-page"
    assert edge["session_id"] == "s1"
    assert edge["created_at"]  # provenance timestamp present


def test_merge_fuzzy_merges_across_sessions_and_upgrades_name(tmp_path):
    knowledge_graph.merge_extraction(tmp_path, "s1", _ext([_person(0, "Marcus")]))
    knowledge_graph.merge_extraction(tmp_path, "s2", _ext([_person(0, "Marcus Lee")]))
    graph = knowledge_graph.load_graph(tmp_path)
    assert len(graph["nodes"]) == 1
    (node,) = graph["nodes"].values()
    assert node["name"] == "Marcus Lee"          # upgraded to the longer form
    assert "Marcus" in node["aliases"]           # shorter form kept as alias
    assert node["sessions"] == ["s1", "s2"]
    assert node["id"] == "person:marcus"         # id fixed at creation time


def test_merge_matches_via_alias(tmp_path):
    knowledge_graph.merge_extraction(tmp_path, "s1", _ext([_person(0, "Sarah Klein", aliases=["design lead"])]))
    knowledge_graph.merge_extraction(tmp_path, "s2", _ext([_person(0, "design lead")]))
    graph = knowledge_graph.load_graph(tmp_path)
    assert len(graph["nodes"]) == 1
    assert graph["nodes"]["person:sarah-klein"]["sessions"] == ["s1", "s2"]


def test_merge_topic_and_project_share_a_merge_class(tmp_path):
    knowledge_graph.merge_extraction(
        tmp_path, "s1", _ext([{"id": 0, "type": "topic", "name": "pricing page", "aliases": []}])
    )
    knowledge_graph.merge_extraction(
        tmp_path, "s2", _ext([{"id": 0, "type": "project", "name": "pricing page redesign", "aliases": []}])
    )
    graph = knowledge_graph.load_graph(tmp_path)
    assert len(graph["nodes"]) == 1
    (node,) = graph["nodes"].values()
    assert sorted(node["sessions"]) == ["s1", "s2"]


def test_merge_never_crosses_person_and_subject_classes(tmp_path):
    knowledge_graph.merge_extraction(tmp_path, "s1", _ext([_person(0, "Jordan")]))
    knowledge_graph.merge_extraction(
        tmp_path, "s2", _ext([{"id": 0, "type": "project", "name": "Jordan", "aliases": []}])
    )
    assert len(knowledge_graph.load_graph(tmp_path)["nodes"]) == 2


def test_ambiguous_bare_first_name_is_not_merged(tmp_path):
    knowledge_graph.merge_extraction(tmp_path, "s1", _ext([_person(0, "Marcus Lee")]))
    knowledge_graph.merge_extraction(tmp_path, "s2", _ext([_person(0, "Marcus Chen")]))
    knowledge_graph.merge_extraction(tmp_path, "s3", _ext([_person(0, "Marcus")]))
    graph = knowledge_graph.load_graph(tmp_path)
    # Bare "Marcus" must become its own third node, merged into neither.
    assert len(graph["nodes"]) == 3


def test_unambiguous_bare_first_name_still_merges(tmp_path):
    knowledge_graph.merge_extraction(tmp_path, "s1", _ext([_person(0, "Marcus Lee")]))
    knowledge_graph.merge_extraction(tmp_path, "s2", _ext([_person(0, "Marcus")]))
    assert len(knowledge_graph.load_graph(tmp_path)["nodes"]) == 1


def test_relation_referencing_unknown_local_id_is_dropped(tmp_path):
    extraction = _ext(
        [_person(0, "Sarah Klein")],
        [{"source_id": 0, "relation": "owns", "target_id": 99}],  # 99 doesn't exist
    )
    knowledge_graph.merge_extraction(tmp_path, "s1", extraction)
    graph = knowledge_graph.load_graph(tmp_path)
    assert graph["edges"] == []
    assert graph["indexed_sessions"] == ["s1"]  # rest of the merge still lands


def test_entities_with_invalid_type_or_empty_name_are_skipped(tmp_path):
    extraction = _ext([
        {"id": 0, "type": "date", "name": "August 15th", "aliases": []},  # off-schema type
        {"id": 1, "type": "person", "name": "   ", "aliases": []},        # empty name
        _person(2, "Sarah Klein"),
    ])
    knowledge_graph.merge_extraction(tmp_path, "s1", extraction)
    assert set(knowledge_graph.load_graph(tmp_path)["nodes"]) == {"person:sarah-klein"}


def test_merge_is_noop_for_already_indexed_session(tmp_path):
    knowledge_graph.merge_extraction(tmp_path, "s1", _ext([_person(0, "Sarah Klein")]))
    knowledge_graph.merge_extraction(tmp_path, "s1", _ext([_person(0, "Jordan")]))
    graph = knowledge_graph.load_graph(tmp_path)
    assert set(graph["nodes"]) == {"person:sarah-klein"}
    assert graph["indexed_sessions"] == ["s1"]


def test_merge_preserves_old_graph_if_replace_fails(tmp_path, monkeypatch):
    knowledge_graph.merge_extraction(tmp_path, "s1", _ext([_person(0, "Sarah Klein")]))

    def broken_replace(src, dst):
        raise OSError("simulated crash during replace")

    monkeypatch.setattr(knowledge_graph.os, "replace", broken_replace)
    with pytest.raises(OSError):
        knowledge_graph.merge_extraction(tmp_path, "s2", _ext([_person(0, "Jordan")]))
    monkeypatch.undo()

    graph = knowledge_graph.load_graph(tmp_path)
    assert graph["indexed_sessions"] == ["s1"]
    assert set(graph["nodes"]) == {"person:sarah-klein"}


def test_concurrent_merges_do_not_lose_data(tmp_path):
    names = ["Alice Adams", "Bob Baker", "Carol Chen", "David Diaz",
             "Erin Evans", "Frank Field", "Grace Green", "Henry Hunt"]

    def worker(i):
        knowledge_graph.merge_extraction(tmp_path, f"s{i}", _ext([_person(0, names[i])]))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    graph = knowledge_graph.load_graph(tmp_path)
    assert len(graph["nodes"]) == 8
    assert sorted(graph["indexed_sessions"]) == sorted(f"s{i}" for i in range(8))


# ---------- remove_session ----------

def _two_meeting_graph(tmp_path):
    knowledge_graph.merge_extraction(tmp_path, "s1", _ext(
        [_person(1, "Sarah Klein"), {"id": 2, "type": "project", "name": "Apollo", "aliases": []}],
        [{"source_id": 1, "relation": "leads", "target_id": 2}],
    ))
    knowledge_graph.merge_extraction(tmp_path, "s2", _ext(
        [_person(1, "Sarah Klein"), {"id": 2, "type": "decision", "name": "Ship in May", "aliases": []}],
        [{"source_id": 1, "relation": "decided", "target_id": 2}],
    ))


def test_remove_session_strips_edges_nodes_and_index_entry(tmp_path):
    _two_meeting_graph(tmp_path)

    assert knowledge_graph.remove_session(tmp_path, "s1") is True

    graph = knowledge_graph.load_graph(tmp_path)
    assert graph["indexed_sessions"] == ["s2"]
    assert [e["relation"] for e in graph["edges"]] == ["decided"]
    names = {n["name"]: n for n in graph["nodes"].values()}
    assert set(names) == {"Sarah Klein", "Ship in May"}  # Apollo only came from s1
    assert names["Sarah Klein"]["sessions"] == ["s2"]


def test_remove_session_last_meeting_leaves_an_empty_graph(tmp_path):
    _two_meeting_graph(tmp_path)
    knowledge_graph.remove_session(tmp_path, "s1")
    knowledge_graph.remove_session(tmp_path, "s2")
    assert knowledge_graph.load_graph(tmp_path) == knowledge_graph.empty_graph()


def test_remove_session_unknown_session_does_not_write(tmp_path):
    _two_meeting_graph(tmp_path)
    path = tmp_path / "knowledge_graph.json"
    before = path.stat().st_mtime_ns

    assert knowledge_graph.remove_session(tmp_path, "nope") is False
    assert path.stat().st_mtime_ns == before


def test_remove_session_missing_graph_is_a_noop(tmp_path):
    assert knowledge_graph.remove_session(tmp_path, "s1") is False
    assert not (tmp_path / "knowledge_graph.json").exists()


def test_remove_session_allows_the_session_to_be_reindexed(tmp_path):
    """indexed_sessions must drop the id too -- otherwise merge_extraction
    would treat a (hypothetically) re-created session id as already done.
    """
    _two_meeting_graph(tmp_path)
    knowledge_graph.remove_session(tmp_path, "s1")
    knowledge_graph.merge_extraction(tmp_path, "s1", _ext([_person(1, "Marcus Lee")]))
    assert "s1" in knowledge_graph.load_graph(tmp_path)["indexed_sessions"]
