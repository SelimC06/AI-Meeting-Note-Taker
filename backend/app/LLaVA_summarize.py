from pathlib import Path
import base64, io, json, os, re
from PIL import Image
from typing import List, Optional

from . import ollama_client

OLLAMA_BASE = ollama_client.resolve_ollama_base()
# Summarization is text-only in practice (server.py never passes
# frame_paths), so it shares the same configurable chat model by default
# instead of a hardcoded vision model. OLLAMA_VISION_MODEL is kept as an
# explicit override for the rare case someone does want frame-based
# (screenshot) summarization later, but it's no longer the silent default.
DEFAULT_MODEL = os.getenv("OLLAMA_VISION_MODEL", os.getenv("OLLAMA_CHAT_MODEL", "gemma3:4b"))

# Health checks get a short, fixed timeout; the generation call gets a
# generous, configurable one (local vision models can take minutes to
# produce a first token after a cold load).
OLLAMA_TIMEOUT_SECONDS = ollama_client.resolve_timeout_seconds("LLaVA_summarize")

_client = ollama_client.make_generation_client(OLLAMA_BASE, OLLAMA_TIMEOUT_SECONDS)
# Separate instance from _client so the health check's short timeout can never
# be affected by (or fight with) whatever timeout the generation call needs.
_health_client = ollama_client.make_health_client(OLLAMA_BASE)

def _assert_ollama_up():
    # Quick connectivity check; will raise if server isn’t up
    _health_client.list()

def _img_to_b64_resized(path: str, max_px: int = 640, jpeg_quality: int = 70) -> str:
    with Image.open(path) as im:
        im = im.convert("RGB")
        w, h = im.size
        scale = max(w, h) / float(max_px)
        if scale > 1.0:
            im = im.resize((int(round(w/scale)), int(round(h/scale))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=jpeg_quality, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("utf-8")

def complete(
    raw_txt_path, 
    out_path=None, 
    model=DEFAULT_MODEL, 
    frame_paths=None,      # list of image paths
    max_images=4,          # keep it small
    max_image_px=1280,     # downscale large frames
    jpeg_quality=80,       # compress
    max_chars=12000,       # trim long transcripts
    stream=False,          # set True to avoid “stuck” feel
    num_ctx=8192,          # give LLaVA more room
    num_predict=800,
    image_prompt: str = "Use the attached screenshots: extract on-screen text (OCR), headings, names, dates, and decisions. If a screenshot only shows part of the meeting, say so and summarize only that portion. Do not invent missing sections.",
    temperature=0.3,
    on_token=None,
    client=None, ):

    active_client = client if client is not None else _client
    if client is None:
        _assert_ollama_up()
    else:
        client.list()

    transcript = Path(raw_txt_path).read_text(encoding="utf-8")
    # max_chars used to be accepted but never applied -- a long transcript
    # could blow past num_ctx and Ollama silently truncated the whole
    # prompt (including the system instructions after it), instead of just
    # the transcript. Truncate here, before it's ever embedded in the
    # prompt, so the instructions and template always survive intact.
    if max_chars is not None and len(transcript) > max_chars:
        transcript = transcript[:max_chars] + "\n[transcript truncated]"

    system_prompt = (
        "You are a precise meeting-notes assistant.\n"
        "- Output ONLY valid Markdown.\n"
        "- Fill EVERY section of the template; if unknown, leave the section but put '- (none)'.\n"
        "- DO NOT quote or reproduce the transcript verbatim (no long paragraphs copied).\n"
        "- Use short bullets with concrete nouns/verbs; keep each bullet ≤ 20 words.\n"
        "- Never include the raw transcript in your answer."
    )

    template = ("# Title\n"
        "- One-liner purpose of meeting\n\n"
        "## Key Points\n- (bullet)\n- (bullet)\n\n"
        "## Decisions\n- (decision)\n\n"
        "## Action Items\n-(action)\n\n"
        "## Open Questions\n- (question)\n\n"
        "## Timeline / Dates Mentioned\n- (item)\n"
        )

    chunks = []
    if transcript:
        chunks.append("Summarize the transcript into the template below.\n\nTranscript (do not quote directly):\n\"\"\"" + transcript + "\"\"\"\n")
    else:
        chunks.append("No text transcript is provided. Derive the summary ONLY from the screenshots.\n")
    chunks.append("Image instructions:\n" + image_prompt + "\n")
    chunks.append("Template:\n" + template)
    user_prompt = "\n".join(chunks)

    images: List[str] = []
    if frame_paths:
        for p in list(frame_paths)[:max_images]:
            try:
                images.append(_img_to_b64_resized(p, max_px=max_image_px, jpeg_quality=jpeg_quality))
            except Exception:
                pass

    
    messages=[
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt, **({"images": images} if images else {})},
    ]
    options = {
        "temperature": float(temperature),
        "num_predict": int(num_predict),
        "num_ctx": int(num_ctx),
    }

    if stream:
        parts = []
        for chunk in active_client.chat(model=model, messages=messages, options=options, stream=True):
            delta = chunk.get("message", {}).get("content", "")
            if delta:
                parts.append(delta)
                if on_token:
                    on_token(delta)
        md = "".join(parts).strip()
    else:
        resp = active_client.chat(model=model, messages=messages, options=options, stream=False)
        md = resp["message"]["content"].strip()

    if out_path:
        Path(out_path).write_text(md, encoding="utf-8")

    return md


# --- Structured action items -------------------------------------------
#
# The chat model used here is a small (~4B-parameter) local model. Unlike
# `complete()`'s free-form Markdown (where drift just means an odd-looking
# bullet), a JSON contract can fail outright: the model can return prose
# wrapped around a JSON object, a code-fenced blob, truncated/invalid JSON,
# or a shape that's missing the fields we asked for. extract_action_items()
# below is built around that failure mode explicitly -- see its docstring.

_ACTION_ITEMS_SCHEMA_HINT = (
    '{"action_items": [{"text": "string, required", '
    '"owner": "string or null", "due": "string or null"}]}'
)

_FENCED_JSON_RE = re.compile(r"```(?:json)?\s*(\{.*\})\s*```", re.DOTALL | re.IGNORECASE)


def _extract_json_object(text: str) -> Optional[str]:
    """Best-effort: pull a single {...} JSON object out of `text`, which may
    have prose or a markdown code fence around it -- a small local model
    asked for "only JSON" frequently doesn't comply literally."""
    text = text.strip()
    fenced = _FENCED_JSON_RE.search(text)
    if fenced:
        return fenced.group(1)
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start:end + 1]
    return None


def _parse_action_items(raw_content: str) -> Optional[List[dict]]:
    """Parse the model's action-items response into a list of
    {"text", "owner", "due"} dicts.

    Returns None (never raises) on ANY shape of failure -- unparseable JSON,
    JSON that isn't an object, a missing/non-list "action_items" key, or an
    entry with no usable text -- so the caller can treat "None" uniformly as
    "this attempt didn't produce usable structured data" regardless of which
    way the small model's output went wrong.
    """
    candidate = _extract_json_object(raw_content)
    if candidate is None:
        return None
    try:
        data = json.loads(candidate)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    items = data.get("action_items")
    if not isinstance(items, list):
        return None

    parsed: List[dict] = []
    for item in items:
        if isinstance(item, str):
            text = item.strip()
            if text:
                parsed.append({"text": text, "owner": None, "due": None})
            continue
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        owner = item.get("owner")
        due = item.get("due")
        parsed.append({
            "text": text.strip(),
            "owner": owner.strip() if isinstance(owner, str) and owner.strip() else None,
            "due": due.strip() if isinstance(due, str) and due.strip() else None,
        })
    return parsed


def extract_action_items(
    raw_txt_path,
    model=DEFAULT_MODEL,
    max_chars: int = 12000,
    num_ctx: int = 8192,
    num_predict: int = 400,
    temperature: float = 0.2,
    client=None,
) -> Optional[List[dict]]:
    """Ask the model for action items as structured JSON.

    A local ~4B model WILL sometimes return malformed JSON, JSON wrapped in
    prose, or a shape missing the fields asked for -- this is designed
    around that failure mode explicitly, not just "ask for JSON":

      1. Ask once, using Ollama's JSON mode plus a schema reminder, and try
         to parse the response.
      2. On parse failure, retry ONCE with a stricter prompt that calls out
         the previous failure and demands JSON with no surrounding text.
      3. If that also fails to parse, return None. The caller (server.py)
         must treat None as "no structured data for this session" and fall
         back to the existing prose `notes` rendering -- never surface a
         broken/empty checklist or an error to the user.

    A transport-level failure (Ollama unreachable, timeout, etc.) is NOT
    retried here -- it propagates immediately, same as `complete()`, so the
    caller's single try/except fallback handles it uniformly with every
    other summarization failure.

    Returns a list of {"text", "owner", "due"} dicts (possibly empty, if the
    model legitimately found no action items), or None if both attempts
    failed to produce parseable structured data.
    """
    active_client = client if client is not None else _client
    if client is None:
        _assert_ollama_up()
    else:
        client.list()

    transcript = Path(raw_txt_path).read_text(encoding="utf-8")
    if max_chars is not None and len(transcript) > max_chars:
        transcript = transcript[:max_chars] + "\n[transcript truncated]"

    base_system_prompt = (
        "You are a precise meeting-notes assistant extracting action items "
        "as JSON.\n"
        "- Respond with ONLY a single JSON object, no prose before or after, "
        "no markdown code fences.\n"
        "- Shape: " + _ACTION_ITEMS_SCHEMA_HINT + "\n"
        '- If there are no action items, return {"action_items": []}.\n'
        "- Only set \"owner\" or \"due\" when a name or date is actually "
        "stated in the transcript -- use null rather than guessing or "
        "inventing one.\n"
        "- Do not quote or reproduce the transcript verbatim."
    )
    strict_system_prompt = (
        base_system_prompt + "\n"
        "- STRICT MODE: your previous response was not valid JSON. Output "
        "ONLY valid JSON this time -- no markdown code fences, no "
        "explanation, no leading or trailing text of any kind."
    )

    user_prompt = (
        "Extract action items from this transcript as JSON.\n\n"
        "Transcript (do not quote directly):\n\"\"\"" + transcript + "\"\"\"\n"
    )

    options = {
        "temperature": float(temperature),
        "num_predict": int(num_predict),
        "num_ctx": int(num_ctx),
    }

    for system_prompt in (base_system_prompt, strict_system_prompt):
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        resp = active_client.chat(
            model=model, messages=messages, options=options, stream=False, format="json"
        )
        content = resp["message"]["content"].strip()
        parsed = _parse_action_items(content)
        if parsed is not None:
            return parsed

    return None