import json

import pytest

import app.graph_extract as graph_extract
from app.graph_extract import Extraction


def _extraction_json(entities=None, relations=None):
    return json.dumps({"entities": entities or [], "relations": relations or []})


SAMPLE_ENTITIES = [
    {"id": 0, "type": "person", "name": "Sarah Klein", "aliases": ["Sarah"]},
    {"id": 1, "type": "project", "name": "pricing page", "aliases": []},
]
SAMPLE_RELATIONS = [
    {"source_id": 0, "relation": "owns", "target_id": 1},
    {"source_id": 1, "relation": "launches on", "target_id": 0},
]


def test_extract_pass_parses_schema_valid_response(monkeypatch):
    captured = {}

    def fake_chat(model, messages, format, options, stream):
        captured["model"] = model
        captured["format"] = format
        captured["messages"] = messages
        captured["stream"] = stream
        return {"message": {"content": _extraction_json(SAMPLE_ENTITIES, SAMPLE_RELATIONS)}}

    monkeypatch.setattr(graph_extract._client, "chat", fake_chat)
    result = graph_extract.extract_pass("some meeting notes", model="test-model")
    assert captured["model"] == "test-model"
    assert captured["stream"] is False
    assert captured["format"] == Extraction.model_json_schema()
    assert "some meeting notes" in captured["messages"][-1]["content"]
    assert [e.name for e in result.entities] == ["Sarah Klein", "pricing page"]
    assert len(result.relations) == 2


def test_extract_pass_raises_on_schema_invalid_response(monkeypatch):
    def fake_chat(model, messages, format, options, stream):
        return {"message": {"content": '{"entities": "not a list"}'}}

    monkeypatch.setattr(graph_extract._client, "chat", fake_chat)
    with pytest.raises(Exception):
        graph_extract.extract_pass("notes", model="test-model")


def test_verify_pass_removes_exactly_the_false_verdict_relations(monkeypatch):
    captured = {}

    def fake_chat(model, messages, format, options, stream):
        captured["messages"] = messages
        return {"message": {"content": json.dumps({"verdicts": [True, False]})}}

    monkeypatch.setattr(graph_extract._client, "chat", fake_chat)
    extraction = Extraction.model_validate({"entities": SAMPLE_ENTITIES, "relations": SAMPLE_RELATIONS})
    result = graph_extract.verify_pass("notes", extraction, model="test-model")
    assert len(result.relations) == 1
    assert result.relations[0].relation == "owns"
    assert result.entities == extraction.entities
    # The claims list sent to the model names entities, numbered from 1.
    user_content = captured["messages"][-1]["content"]
    assert "1. Sarah Klein -- owns -- pricing page" in user_content
    assert "2. pricing page -- launches on -- Sarah Klein" in user_content


def test_verify_pass_skips_the_llm_call_when_no_relations(monkeypatch):
    calls = []
    monkeypatch.setattr(graph_extract._client, "chat", lambda **kw: calls.append(kw))
    extraction = Extraction.model_validate({"entities": SAMPLE_ENTITIES, "relations": []})
    result = graph_extract.verify_pass("notes", extraction, model="test-model")
    assert result is extraction
    assert calls == []


def test_verify_pass_passes_through_on_verdict_count_mismatch(monkeypatch):
    def fake_chat(model, messages, format, options, stream):
        return {"message": {"content": json.dumps({"verdicts": [True]})}}  # 1 verdict, 2 relations

    monkeypatch.setattr(graph_extract._client, "chat", fake_chat)
    extraction = Extraction.model_validate({"entities": SAMPLE_ENTITIES, "relations": SAMPLE_RELATIONS})
    result = graph_extract.verify_pass("notes", extraction, model="test-model")
    assert len(result.relations) == 2  # spec fallback: approve everything


def test_extract_from_notes_chains_extract_then_verify(monkeypatch):
    responses = [
        {"message": {"content": _extraction_json(SAMPLE_ENTITIES, SAMPLE_RELATIONS)}},
        {"message": {"content": json.dumps({"verdicts": [False, True]})}},
    ]

    def fake_chat(model, messages, format, options, stream):
        return responses.pop(0)

    monkeypatch.setattr(graph_extract._client, "chat", fake_chat)
    result = graph_extract.extract_from_notes("notes", model="test-model")
    assert len(result.entities) == 2
    assert len(result.relations) == 1
    assert result.relations[0].relation == "launches on"


def test_extract_from_notes_returns_empty_extraction_when_extract_fails_validation(monkeypatch):
    def fake_chat(model, messages, format, options, stream):
        return {"message": {"content": "garbage that is not json"}}

    monkeypatch.setattr(graph_extract._client, "chat", fake_chat)
    result = graph_extract.extract_from_notes("notes", model="test-model")
    assert result.entities == []
    assert result.relations == []


def test_extract_from_notes_keeps_unverified_extraction_when_verify_fails(monkeypatch):
    responses = [
        {"message": {"content": _extraction_json(SAMPLE_ENTITIES, SAMPLE_RELATIONS)}},
        {"message": {"content": "garbage that is not json"}},
    ]

    def fake_chat(model, messages, format, options, stream):
        return responses.pop(0)

    monkeypatch.setattr(graph_extract._client, "chat", fake_chat)
    result = graph_extract.extract_from_notes("notes", model="test-model")
    assert len(result.relations) == 2  # base extraction survives a verify hiccup


def test_resolve_graph_model_prefers_env_override(monkeypatch):
    monkeypatch.setenv("GRAPH_MODEL", "qwen2.5:3b")
    assert graph_extract.resolve_graph_model("gemma3:4b") == "qwen2.5:3b"
    monkeypatch.delenv("GRAPH_MODEL")
    assert graph_extract.resolve_graph_model("gemma3:4b") == "gemma3:4b"
