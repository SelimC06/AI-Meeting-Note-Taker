import numpy as np
import pytest

from app import speaker_id


@pytest.fixture(autouse=True)
def _profiles_in_tmp(tmp_path):
    """Point the profile store at a temp dir and restore afterwards, same
    convention as test_builtin_llm's state reset."""
    speaker_id.configure(tmp_path)
    yield
    with speaker_id._LOCK:
        speaker_id._PROFILES_DIR = None


def _unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v)


# Two well-separated synthetic "voices" plus small perturbations.
VOICE_A = _unit([1.0, 0.1, 0.0, 0.0])
VOICE_A2 = _unit([0.9, 0.2, 0.05, 0.0])
VOICE_B = _unit([0.0, 0.1, 1.0, 0.2])
VOICE_B2 = _unit([0.05, 0.0, 0.9, 0.3])


def test_cluster_embeddings_groups_similar_voices():
    labels = speaker_id.cluster_embeddings([VOICE_A, VOICE_B, VOICE_A2, VOICE_B2])
    assert labels[0] == labels[2]
    assert labels[1] == labels[3]
    assert labels[0] != labels[1]


def test_cluster_embeddings_single_and_empty():
    assert speaker_id.cluster_embeddings([]) == []
    assert speaker_id.cluster_embeddings([VOICE_A]) == [0]


def test_diarize_segments_labels_by_first_appearance_and_fills_short_segments(monkeypatch, tmp_path):
    segments = [
        {"start": 0.0, "end": 2.0, "text": "a"},     # voice A
        {"start": 2.0, "end": 2.2, "text": "mhm"},   # too short -> inherits nearest
        {"start": 3.0, "end": 5.0, "text": "b"},     # voice B
        {"start": 5.0, "end": 7.0, "text": "a2"},    # voice A again
    ]

    def fake_embed_spans(wav_path, spans):
        return [VOICE_A, None, VOICE_B, VOICE_A2]

    monkeypatch.setattr(speaker_id, "embed_spans", fake_embed_spans)

    labels, centroids = speaker_id.diarize_segments(tmp_path / "x.wav", segments)
    assert labels == ["SPEAKER_00", "SPEAKER_00", "SPEAKER_01", "SPEAKER_00"]
    assert set(centroids) == {"SPEAKER_00", "SPEAKER_01"}
    # Centroids are L2-normalized.
    for c in centroids.values():
        assert np.linalg.norm(np.asarray(c)) == pytest.approx(1.0, abs=1e-4)


def test_diarize_segments_without_any_embeddings_returns_no_labels(monkeypatch, tmp_path):
    monkeypatch.setattr(speaker_id, "embed_spans", lambda wav_path, spans: [None, None])
    labels, centroids = speaker_id.diarize_segments(
        tmp_path / "x.wav", [{"start": 0, "end": 0.1}, {"start": 1, "end": 1.1}]
    )
    assert labels == [None, None]
    assert centroids == {}


def test_learn_profile_running_mean_and_list_shape():
    speaker_id.learn_profile("Maya", VOICE_A)
    speaker_id.learn_profile("Maya", VOICE_A2)
    profiles = speaker_id.load_profiles()
    assert profiles["Maya"]["count"] == 2
    emb = np.asarray(profiles["Maya"]["embedding"], dtype=np.float32)
    assert np.linalg.norm(emb) == pytest.approx(1.0, abs=1e-4)
    # The mean sits between the two contributions, close to both.
    assert float(emb @ VOICE_A) > 0.95

    listed = speaker_id.list_profiles()
    assert listed == [
        {"name": "Maya", "meetings": 2, "updated_at": profiles["Maya"]["updated_at"]}
    ]


def test_learn_profile_ignores_blank_names_and_zero_vectors():
    speaker_id.learn_profile("   ", VOICE_A)
    speaker_id.learn_profile("Ghost", [0.0, 0.0, 0.0, 0.0])
    assert speaker_id.load_profiles() == {}


def test_match_profiles_respects_threshold():
    speaker_id.learn_profile("Maya", VOICE_A)
    matches = speaker_id.match_profiles({
        "SPEAKER_00": [float(x) for x in VOICE_A2],  # ~same voice
        "SPEAKER_01": [float(x) for x in VOICE_B],   # different voice
    })
    assert matches == {"SPEAKER_00": "Maya"}


def test_forget_profile():
    speaker_id.learn_profile("Maya", VOICE_A)
    assert speaker_id.forget_profile("Maya") is True
    assert speaker_id.forget_profile("Maya") is False
    assert speaker_id.list_profiles() == []


def test_session_embeddings_round_trip_and_corruption_tolerance(tmp_path):
    session = tmp_path / "session"
    session.mkdir()
    speaker_id.write_session_embeddings(session, {"SPEAKER_00": [0.1, 0.2]})
    speaker_id.write_session_embeddings(session, {"SPEAKER_01": [0.3, 0.4]})
    loaded = speaker_id.load_session_embeddings(session)
    assert set(loaded) == {"SPEAKER_00", "SPEAKER_01"}

    (session / speaker_id.SESSION_EMBEDDINGS_FILENAME).write_text("{oops", encoding="utf-8")
    assert speaker_id.load_session_embeddings(session) == {}


def test_centroids_for_labeled_segments_skips_provenance_buckets(monkeypatch, tmp_path):
    segments = [
        {"start": 0.0, "end": 2.0, "speaker": "You"},
        {"start": 2.0, "end": 4.0, "speaker": "SPEAKER_00"},
        {"start": 4.0, "end": 6.0, "speaker": "SPEAKER_00"},
        {"start": 6.0, "end": 8.0, "speaker": "Others"},
        {"start": 8.0, "end": 9.0, "speaker": None},
    ]

    def fake_embed_spans(wav_path, spans):
        return [VOICE_A for _ in spans]

    monkeypatch.setattr(speaker_id, "embed_spans", fake_embed_spans)
    centroids = speaker_id.centroids_for_labeled_segments(tmp_path / "x.wav", segments)
    assert set(centroids) == {"SPEAKER_00"}


def test_available_is_false_without_a_model(monkeypatch):
    monkeypatch.setattr(speaker_id, "SPEAKER_MODEL_PATH", "")
    assert speaker_id.available() is False
