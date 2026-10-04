from app.note_templates import (
    BUILTIN_TEMPLATES,
    DEFAULT_TEMPLATE_BODY,
    TEMPLATE_IDS,
    TITLE_LINE,
    resolve_template_body,
)


def test_builtin_ids_are_unique_and_custom_is_selectable():
    ids = [t["id"] for t in BUILTIN_TEMPLATES]
    assert len(ids) == len(set(ids))
    assert TEMPLATE_IDS == set(ids) | {"custom"}


def test_every_builtin_keeps_the_title_contract():
    # extract_title and the summarizer's title rule depend on the first
    # line being the parenthesized placeholder, for every meeting type.
    for template in BUILTIN_TEMPLATES:
        assert template["body"].startswith(TITLE_LINE)
        assert template["label"]
        assert template["description"]


def test_resolve_builtin_custom_and_fallbacks():
    assert "## Blockers" in resolve_template_body("standup", "")
    assert resolve_template_body("custom", "# (t)\n## Mine\n- x") == "# (t)\n## Mine\n- x\n"
    # Empty custom body, unknown id, and None all fall back to general.
    assert resolve_template_body("custom", "   ") == DEFAULT_TEMPLATE_BODY
    assert resolve_template_body("brainstorm", "") == DEFAULT_TEMPLATE_BODY
    assert resolve_template_body(None, None) == DEFAULT_TEMPLATE_BODY
