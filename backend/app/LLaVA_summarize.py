from pathlib import Path
import httpx
import ollama
import base64, io, os
from PIL import Image
from typing import List

OLLAMA_BASE = os.getenv("OLLAMA_BASE_URL") or os.getenv("OLLAMA_HOST") or "http://localhost:11434"
DEFAULT_MODEL = os.getenv("OLLAMA_VISION_MODEL", "llava:7b-v1.5-q4_K_M")

# ollama.Client defaults to timeout=None, which disables httpx's timeout
# entirely -- a wedged Ollama then blocks the job worker's summarize step
# forever, permanently stalling every recording queued behind it. Health
# checks get a short, fixed timeout; the generation call gets a generous,
# configurable one (local vision models can take minutes to produce a first
# token after a cold load).
OLLAMA_TIMEOUT_SECONDS = float(os.getenv("OLLAMA_TIMEOUT_SECONDS", "300"))
_HEALTH_TIMEOUT = httpx.Timeout(connect=5.0, read=5.0, write=5.0, pool=5.0)
_GENERATION_TIMEOUT = httpx.Timeout(connect=5.0, read=OLLAMA_TIMEOUT_SECONDS, write=30.0, pool=30.0)

_client = ollama.Client(host=OLLAMA_BASE, timeout=_GENERATION_TIMEOUT)
# Separate instance from _client so the health check's short timeout can never
# be affected by (or fight with) whatever timeout the generation call needs.
_health_client = ollama.Client(host=OLLAMA_BASE, timeout=_HEALTH_TIMEOUT)

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
    on_token=None, ):

    _assert_ollama_up()

    transcript = Path(raw_txt_path).read_text(encoding="utf-8")

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
        "num_gpu": 0,
    }

    if stream:
        parts = []
        for chunk in _client.chat(model=model, messages=messages, options=options, stream=True):
            delta = chunk.get("message", {}).get("content", "")
            if delta:
                parts.append(delta)
                if on_token:
                    on_token(delta)
        md = "".join(parts).strip()
    else:
        resp = _client.chat(model=model, messages=messages, options=options, stream=False)
        md = resp["message"]["content"].strip()

    if out_path:
        Path(out_path).write_text(md, encoding="utf-8")

    return md